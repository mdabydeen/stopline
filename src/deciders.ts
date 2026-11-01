import type {
  Answer,
  Decider,
  Evaluation,
  Question,
  Questions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function trimBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

// A gateway base URL may be https anywhere, but plain http only for a local
// proxy or test server. Never send a bearer token to a remote http host.
function assertGatewayBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Jev gateway base URL is not a valid URL: ${JSON.stringify(baseUrl)}`);
  }
  if (url.protocol === "https:") return;
  const local =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (local) return;
  throw new Error(
    `Jev gateway base URL must use https, or http only for localhost/127.0.0.1 (got ${url.protocol}//${url.hostname})`,
  );
}

// Read a response body with a hard cap. The cap is enforced before the body is
// parsed so a hostile or broken backend cannot exhaust memory.
async function readBodyCapped(
  res: Response,
  limit: number,
  label: string,
): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${label} response exceeded ${limit} bytes`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} response exceeded ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type PostJsonOptions = {
  url: string;
  label: string;
  headers: Record<string, string>;
  payload: unknown;
  timeoutMs: number;
  maxAttempts: number;
};

// Shared POST path for both backends: bounded body, per-attempt timeout, and a
// small retry set for transient gateway failures. Error messages deliberately
// omit the response body, which can echo page text or secrets.
async function postJson(opts: PostJsonOptions): Promise<{ raw: any; latencyMs: number }> {
  const started = performance.now();
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: JSON.stringify(opts.payload),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      // Timeouts and connection failures are not safely retryable here.
      throw new Error(`${opts.label} request failed: ${errorMessage(e)}`);
    }

    if (!res.ok) {
      const status = `${res.status} ${res.statusText}`.trim();
      lastError = new Error(`${opts.label} responded ${status}`);
      if (RETRY_STATUS.has(res.status) && attempt < opts.maxAttempts) {
        await res.body?.cancel().catch(() => {});
        await sleep(100 * attempt);
        continue;
      }
      await res.body?.cancel().catch(() => {});
      throw lastError;
    }

    const body = await readBodyCapped(res, MAX_RESPONSE_BYTES, opts.label);
    let raw: any;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new Error(`${opts.label} returned invalid JSON`);
    }
    return { raw, latencyMs: performance.now() - started };
  }

  throw lastError ?? new Error(`${opts.label} request failed`);
}

// Jev through Vercel AI Gateway's HTTP evaluate endpoint.
// Auth: AI_GATEWAY_API_KEY, or the VERCEL_OIDC_TOKEN written by `vercel env pull`.
export class JevGatewayDecider implements Decider {
  readonly name = "jev (vercel ai gateway)";
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(
    opts: {
      baseUrl?: string;
      model?: string;
      timeoutMs?: number;
      maxAttempts?: number;
    } = {},
  ) {
    const baseUrl = trimBaseUrl(
      opts.baseUrl ?? process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh",
    );
    assertGatewayBaseUrl(baseUrl);
    this.url = `${baseUrl}/v1/evaluate`;
    this.model = opts.model ?? process.env.JEV_MODEL ?? "typesafe-ai/jev";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  private headers(): Record<string, string> {
    const apiKey = process.env.AI_GATEWAY_API_KEY;
    const oidc = process.env.VERCEL_OIDC_TOKEN;
    if (apiKey) {
      return { authorization: `Bearer ${apiKey}` };
    }
    if (oidc) {
      return {
        authorization: `Bearer ${oidc}`,
        "ai-gateway-auth-method": "oidc",
      };
    }
    throw new Error(
      "No gateway credentials. Set AI_GATEWAY_API_KEY, or run `vercel link && vercel env pull .env.local` and start with --env-file=.env.local.",
    );
  }

  async evaluate(state: string, questions: Questions): Promise<Evaluation> {
    const { raw, latencyMs } = await postJson({
      url: this.url,
      label: "Jev gateway",
      headers: this.headers(),
      payload: { model: this.model, state, questions },
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
    });
    return {
      answers: normaliseAnswers(raw.answers ?? raw, questions),
      latencyMs,
      backend: this.name,
      raw,
    };
  }
}

// Laya running locally through `laya-serve`, which speaks the same
// /v1/systemone wire protocol as TypeSafe's hosted Jev API. Laya calls the
// boolean type `noul`, so questions are translated on the way out.
export class LayaDecider implements Decider {
  readonly name = "laya (local laya-serve)";
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(opts: { baseUrl?: string; timeoutMs?: number; maxAttempts?: number } = {}) {
    const baseUrl = trimBaseUrl(
      opts.baseUrl ?? process.env.LAYA_URL ?? "http://127.0.0.1:8000",
    );
    this.url = `${baseUrl}/v1/systemone`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async evaluate(state: string, questions: Questions): Promise<Evaluation> {
    const translated: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      translated[key] = q.type === "boolean" ? { ...q, type: "noul" } : q;
    }
    const { raw, latencyMs } = await postJson({
      url: this.url,
      label: "laya-serve",
      headers: {},
      payload: { state, questions: translated },
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
    });
    return {
      answers: normaliseAnswers(raw.answers ?? raw, questions),
      latencyMs,
      backend: this.name,
      raw,
    };
  }
}

// Both backends return close to the same shape, but field names differ:
// Jev on the gateway uses `probability`, Laya and the TypeSafe API use `noul`.
export function normaliseAnswers(
  raw: Record<string, any>,
  questions: Questions,
): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = raw[key];
    if (a == null) throw new Error(`Missing answer for "${key}"`);
    out[key] = normaliseOne(a, q);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unitNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      "Answer probability must be a finite number in [0,1]",
    );
  }
  return value;
}

// normaliseOne is the single total parse path over the backends' wire shapes.
// It accepts only answers that match the fixed question schema: unknown
// options, missing probabilities, and out-of-range numbers are errors rather
// than guesses, because a guessed answer could bypass the policy.
function normaliseOne(a: any, q: Question): Answer {
  if (q.type === "boolean") {
    let p: unknown;
    if (typeof a === "number") p = a;
    else if (isRecord(a)) p = a.probability ?? a.noul ?? a.value ?? a.boolean;
    return { type: "boolean", probability: unitNumber(p) };
  }

  if (!isRecord(a)) {
    throw new Error("Choice answer must be an object");
  }
  const probabilitiesRaw = a.probabilities ?? {};
  if (!isRecord(probabilitiesRaw)) {
    throw new Error("Choice answer probabilities must be an object");
  }

  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(probabilitiesRaw)) {
    if (!Object.prototype.hasOwnProperty.call(q.criteria, key)) {
      throw new Error(`Choice answer has unknown option "${key}"`);
    }
    probabilities[key] = unitNumber(value);
  }

  let choice: string;
  if (a.choice !== undefined && a.choice !== null) {
    if (
      typeof a.choice !== "string" ||
      !Object.prototype.hasOwnProperty.call(q.criteria, a.choice)
    ) {
      throw new Error(
        `Choice answer ${JSON.stringify(a.choice)} is not one of the question's options`,
      );
    }
    choice = a.choice;
  } else {
    // Argmax over only the declared options. Object.entries is own-property
    // only, so "__proto__" and "constructor" cannot leak in from the prototype.
    const ranked = Object.entries(probabilities).sort((x, y) => y[1] - x[1]);
    if (ranked.length === 0) {
      throw new Error("Choice answer has no choice and no probabilities");
    }
    choice = ranked[0][0];
  }

  if (!Object.prototype.hasOwnProperty.call(probabilities, choice)) {
    throw new Error(`Choice answer is missing a probability for "${choice}"`);
  }
  return {
    type: "choice",
    choice,
    probabilities,
    confidence: unitNumber(probabilities[choice]),
  };
}

// A keyword heuristic with the same interface. It is not a model. It exists
// so the demo runs offline and so the eval has a naive baseline to beat.
export class KeywordDecider implements Decider {
  readonly name = "keyword baseline (no model)";

  async evaluate(state: string, questions: Questions): Promise<Evaluation> {
    const started = performance.now();
    const line = (label: string) =>
      (state.split("\n").find((l) => l.startsWith(label)) ?? "").slice(label.length).toLowerCase();
    const action = line("PROPOSED ACTION:");
    const task = line("USER TASK:");
    const page = line("PAGE TEXT:");

    const has = (s: string, words: string[]) => words.some((w) => s.includes(w));
    let effect = "read_only";
    if (has(action, ["password", "card", "cc-", "pay", "place order", "buy now", "checkout", "transfer", "one-time"])) {
      effect = "credentials_or_money";
    } else if (has(action, ["post", "send", "submit", "delete", "publish", "reply", "invite", "remove"])) {
      effect = "public_or_irreversible";
    } else if (has(action, ["add to cart", "save", "checkbox", "toggle", "draft"])) {
      effect = "reversible_change";
    }
    const probabilities: Record<string, number> = {
      read_only: 0.02,
      reversible_change: 0.02,
      public_or_irreversible: 0.02,
      credentials_or_money: 0.02,
    };
    probabilities[effect] = 0.94;

    // Compare exact words from the visible action label with the task. Do not
    // treat a URL target as evidence that the action serves the task: a link
    // labelled "Settings" can point into the requested repository while still
    // being unrelated to a request to star it. Exact matching also avoids
    // treating "descale" as a match for the sponsored product "DescalePro".
    const words = (s: string) => s.split(/\W+/).filter((w) => w.length > 3);
    const taskWords = new Set(words(task));
    const visibleAction = action.split("->", 1)[0];
    const overlap = words(visibleAction).some((w) => taskWords.has(w));
    const onTask = overlap ? 0.85 : 0.5;
    const injected = has(page, ["ignore previous", "ignore any earlier", "ai assistant", "ai shopping assistant", "ai agent", "language model"]) ? 0.9 : 0.05;

    const answers: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (key === "effect") answers[key] = { type: "choice", choice: effect, probabilities, confidence: probabilities[effect] ?? 0 };
      else if (key === "servesTask") answers[key] = { type: "boolean", probability: onTask };
      else if (key === "pageInstructsAgent") answers[key] = { type: "boolean", probability: injected };
      else answers[key] = q.type === "boolean" ? { type: "boolean", probability: 0.5 } : { type: "choice", choice: Object.keys(q.criteria)[0], probabilities: {}, confidence: 0 };
    }
    return { answers, latencyMs: performance.now() - started, backend: this.name };
  }
}

export function deciderFromEnv(): Decider {
  const raw = process.env.STOPLINE_BACKEND?.trim().toLowerCase();
  const backend = raw || "jev";
  if (backend === "laya") return new LayaDecider();
  if (backend === "jev") return new JevGatewayDecider();
  if (backend === "keyword") return new KeywordDecider();
  throw new Error(`Unknown STOPLINE_BACKEND "${backend}" (use jev, laya, or keyword)`);
}
