import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { ElementHandle, Locator, Page } from "playwright";
import { decide, DEFAULT_POLICY, type Policy } from "./policy.ts";
import { readBodyText } from "./pageText.ts";
import {
  GATE_QUESTIONS,
  MASKED_VALUE,
  PAGE_TEXT_LIMIT,
  describeAction,
  isSensitiveField,
  renderState,
} from "./questions.ts";
import type {
  Decider,
  Decision,
  Evaluation,
  PageContext,
  ProposedAction,
} from "./types.ts";

// How a caller points at an element. The planner only ever describes a target,
// it never holds the Locator or the Page.
export type TargetSpec =
  | { role: string; name?: string | RegExp }
  | { label: string }
  | { selector: string };

export type Approver = (req: {
  task: string;
  action: ProposedAction;
  decision: Decision;
  // The page the action was judged against, so the human sees the same state
  // the classifier did rather than only the action label.
  page: PageContext;
}) => Promise<boolean>;

// Default approver for unattended runs: nobody is there, so the answer is no.
export const denyAll: Approver = async () => false;

export class StoppedByGate extends Error {
  constructor(
    readonly action: ProposedAction,
    readonly decision: Decision,
  ) {
    super(`stopline ${decision.verdict}: ${describeAction(action)} (${decision.reasons.join("; ")})`);
  }
}

export type EvidenceRecord = {
  at: string;
  // Intent is written before the action may run; outcome after it (or after it
  // was refused). A pair with the same action + timestamp tells the full story.
  phase: "intent" | "outcome";
  task: string;
  action: string;
  page: { url: string; title: string };
  stateSha256: string;
  backend: string | null;
  model: string | null;
  // Snapshot of the thresholds in force, so an old record stays readable after
  // the policy is tuned.
  policy: Policy;
  latencyMs: number | null;
  answers: Evaluation["answers"] | null;
  decision: Decision;
  humanApproved: boolean | null;
  humanApprovedBy?: string | null;
  executed: boolean;
  error?: string;
};

export type GateOptions = {
  task: string;
  decider: Decider;
  approver?: Approver;
  // Identifies who approved "ask" verdicts in the evidence log.
  approverId?: string;
  evidencePath?: string;
  policy?: Policy;
  // The URL the run is allowed to open first, plus any origins the caller has
  // already decided are safe entry points.
  startUrl?: string;
  allowedOrigins?: string[];
  onDecision?: (r: EvidenceRecord) => void;
};

// DOM facts read once before the model runs and again before execution. Values
// are deliberately absent: a fingerprint must never contain a typed secret.
type ElementFacts = {
  tag: string;
  role: string;
  ariaLabel: string;
  text: string;
  href: string;
  formAction: string;
  formMethod: string;
  inputType: string;
  autocomplete: string;
  name: string;
  id: string;
  // Derived display label. Included in the fingerprint because a relabelled
  // element is a different target even if its other attributes did not move.
  label: string;
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Wraps a Playwright page. The agent (LLM planner or script) calls click/fill/
// press/goto instead of page.click/fill/goto, so every side effect crosses the
// line. The Page lives in a #private field on purpose: callers must never hand
// the raw Page (or a Locator taken from it) to planner code, because anything
// holding it can bypass this class entirely.
export class Gate {
  readonly #page: Page;
  readonly #opts: GateOptions;
  // Evidence appends are serialized so concurrent actions cannot interleave
  // partial lines.
  #logQueue: Promise<void> = Promise.resolve();

  constructor(page: Page, opts: GateOptions) {
    this.#page = page;
    this.#opts = { ...opts };
    if (opts.evidencePath) mkdirSync(dirname(opts.evidencePath), { recursive: true });
  }

  async goto(url: string): Promise<void> {
    const first = this.#page.url() === "about:blank";
    // Resolve relative entry paths against the configured start URL, not the
    // blank page. Everything after the first navigation resolves against the
    // page the agent is actually on.
    const base = first ? this.#opts.startUrl : this.#page.url();
    let absolute = url;
    try {
      absolute = new URL(url, base).toString();
    } catch {
      // Keep the caller's string. The guard below turns an invalid target into
      // an ask rather than guessing.
    }

    // The gate still records a decision for the configured entry point. It just
    // does not ask the model to classify a navigation the caller chose.
    const preApproved = first ? this.allowedFirstNavigation(absolute) : null;
    const scheme = this.unsafeScheme(absolute);
    const action: ProposedAction = { kind: "goto", target: "address bar", value: absolute };
    await this.guard(
      action,
      null,
      null,
      async () => {
        await this.#page.goto(absolute);
      },
      { preApproved: preApproved ?? undefined, forceAsk: scheme },
    );
  }

  async click(target: TargetSpec): Promise<void> {
    const { handle, facts, fingerprint } = await this.inspect(target);
    const action = this.actionFor(facts, "click");
    // Same handle for the read and the click. See revalidate() for the limits.
    await this.guard(action, handle, fingerprint, () => handle.click());
  }

  async fill(target: TargetSpec, value: string): Promise<void> {
    const { handle, facts, fingerprint } = await this.inspect(target);
    // A sensitive value never enters the ProposedAction, so it cannot reach the
    // model state, the approver prompt, the evidence log, or StoppedByGate. The
    // real value stays in this closure and is used only for the actual fill.
    const shown = isSensitiveField(facts) ? MASKED_VALUE : value;
    const action = this.actionFor(facts, "fill", shown);
    await this.guard(action, handle, fingerprint, () => handle.fill(value));
  }

  async press(target: TargetSpec, key: string): Promise<void> {
    const { handle, facts, fingerprint } = await this.inspect(target);
    const action = this.actionFor(facts, "press", key);
    await this.guard(action, handle, fingerprint, () => handle.press(key));
  }

  private locate(target: TargetSpec): Locator {
    if ("role" in target) {
      const role = target.role as Parameters<Page["getByRole"]>[0];
      return this.#page.getByRole(role, target.name === undefined ? undefined : { name: target.name });
    }
    if ("label" in target) return this.#page.getByLabel(target.label);
    return this.#page.locator(target.selector);
  }

  // Resolve the target once, to an ElementHandle. The plan is described from
  // that handle and the action later runs on the same handle.
  private async inspect(
    target: TargetSpec,
  ): Promise<{ handle: ElementHandle<Element>; facts: ElementFacts; fingerprint: string }> {
    const handle = (await this.locate(target).elementHandle()) as ElementHandle<Element> | null;
    if (!handle) throw new Error(`stopline: could not resolve target ${JSON.stringify(target)}`);
    const facts = await this.readFacts(handle);
    return { handle, facts, fingerprint: JSON.stringify(facts) };
  }

  private readFacts(handle: ElementHandle<Element>): Promise<ElementFacts> {
    // Keep this callback free of locally-defined helper functions. tsx
    // compiles named inner functions with a __name helper, and Playwright
    // serializes the callback into the page, where __name does not exist.
    return handle.evaluate((el): ElementFacts => {
      const tag = el.tagName.toLowerCase();
      const input = el as HTMLInputElement;
      const inputType =
        el instanceof HTMLInputElement
          ? el.type.toLowerCase()
          : (el.getAttribute("type") ?? "").toLowerCase();
      const labels = input.labels;
      const labelText = labels && labels.length > 0 ? (labels[0].textContent ?? "") : "";

      const ids = el.getAttribute("aria-labelledby");
      let labelledBy = "";
      if (ids) {
        for (const id of ids.split(/\s+/)) {
          const node = document.getElementById(id);
          if (node && node.textContent) labelledBy += node.textContent + " ";
        }
      }

      // Never use input.value as the label. An unlabelled password field would
      // then put the secret into target, model state, and evidence.
      const rawLabel =
        el.getAttribute("aria-label") ||
        labelledBy ||
        labelText ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        el.id ||
        (el as HTMLElement).textContent ||
        "";
      const label = rawLabel.replace(/\s+/g, " ").trim().slice(0, 160);

      const hrefAttr = el.getAttribute("href") ?? "";
      let href = "";
      if (hrefAttr) {
        try {
          href = new URL(hrefAttr, document.baseURI).toString();
        } catch {
          href = hrefAttr;
        }
      }

      const form = input.form ?? el.closest("form");
      const formActionAttr =
        el.getAttribute("formaction") ?? form?.getAttribute("action") ?? "";
      let formAction = "";
      if (formActionAttr) {
        try {
          formAction = new URL(formActionAttr, document.baseURI).toString();
        } catch {
          formAction = formActionAttr;
        }
      }

      return {
        tag,
        role: el.getAttribute("role") ?? "",
        ariaLabel: (el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
        text: ((el as HTMLElement).textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
        href,
        formAction,
        formMethod: (form?.getAttribute("method") ?? "").toLowerCase(),
        inputType,
        autocomplete: el.getAttribute("autocomplete") ?? "",
        name: el.getAttribute("name") ?? "",
        id: el.id,
        label,
      };
    });
  }

  private actionFor(
    facts: ElementFacts,
    kind: ProposedAction["kind"],
    value?: string,
  ): ProposedAction {
    const noun =
      facts.role ||
      (facts.tag === "a"
        ? "link"
        : facts.tag === "input"
          ? ["checkbox", "radio", "submit"].includes(facts.inputType)
            ? facts.inputType
            : "field"
          : facts.tag);
    const extra = facts.href ? ` -> ${facts.href}` : "";
    return {
      kind,
      target: `${noun} "${facts.label}"${extra}`,
      ...(kind === "fill" || kind === "press" ? { value } : {}),
      element: {
        tag: facts.tag,
        inputType: facts.inputType || undefined,
        autocomplete: facts.autocomplete || undefined,
        href: facts.href || undefined,
        formAction: facts.formAction || undefined,
        formMethod: facts.formMethod || undefined,
        name: facts.name || undefined,
        label: facts.label || undefined,
        id: facts.id || undefined,
      },
    };
  }

  private async context(): Promise<PageContext> {
    // textContent, not innerText: DOM-reading agents ingest hidden text too,
    // so the gate reads what the agent reads. That also includes the text of
    // <script> and <style> elements; iframes and shadow roots are not read.
    const text = await readBodyText(this.#page);
    return {
      url: this.#page.url(),
      title: await this.#page.title(),
      text: text.slice(0, PAGE_TEXT_LIMIT * 4),
    };
  }

  // True when the page still offers the same element with the same facts.
  // This narrows the window between reading and acting, but cannot fully
  // eliminate page-side races: a script can change the handler behind an
  // unchanged element right after this check, and nothing short of a frozen
  // page can prevent that.
  private async revalidate(
    handle: ElementHandle<Element>,
    fingerprint: string,
  ): Promise<string | null> {
    try {
      const connected = await handle.evaluate((el) => el.isConnected);
      if (!connected) return "element detached during evaluation";
      const now = JSON.stringify(await this.readFacts(handle));
      if (now !== fingerprint) return "element changed during evaluation";
      return null;
    } catch {
      return "element changed during evaluation (could not re-read it)";
    }
  }

  // A first navigation to the configured start URL, or to an origin the caller
  // has already allowed, is recorded but does not need the classifier.
  private allowedFirstNavigation(absolute: string): string | null {
    let target: URL;
    try {
      target = new URL(absolute);
    } catch {
      return null;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;

    if (this.#opts.startUrl) {
      try {
        if (new URL(this.#opts.startUrl).toString() === target.toString()) {
          return "configured start URL";
        }
      } catch {
        // A malformed configured start URL simply grants nothing.
      }
    }
    for (const origin of this.#opts.allowedOrigins ?? []) {
      try {
        if (new URL(origin).origin === target.origin) return `origin ${target.origin} is allowed`;
      } catch {
        // Ignore malformed entries.
      }
    }
    return null;
  }

  private unsafeScheme(absolute: string): string | undefined {
    try {
      const protocol = new URL(absolute).protocol;
      if (protocol === "http:" || protocol === "https:") return undefined;
      return `navigation scheme ${protocol} is not allowed by default`;
    } catch {
      return "navigation target is not a valid URL";
    }
  }

  private async guard(
    action: ProposedAction,
    handle: ElementHandle<Element> | null,
    fingerprint: string | null,
    run: () => Promise<void>,
    options: { preApproved?: string; forceAsk?: string } = {},
  ): Promise<void> {
    const page = await this.context();
    const state = renderState(this.#opts.task, action, page);
    const policy = this.#opts.policy ?? DEFAULT_POLICY;

    let evaluation: Evaluation | null = null;
    let error: string | undefined;
    if (!options.preApproved) {
      try {
        evaluation = await this.#opts.decider.evaluate(state, GATE_QUESTIONS);
      } catch (e) {
        // No model answer: decide() fails closed to a human below.
        error = errorMessage(e);
      }
    }

    let decision: Decision;
    if (options.preApproved) {
      decision = { verdict: "allow", reasons: [options.preApproved], source: "policy-default" };
    } else {
      try {
        decision = decide(action, page, evaluation?.answers ?? null, policy);
      } catch (e) {
        // A policy bug must not become an opaque crash, and must not allow the
        // action. Fail closed to a human with a recorded reason.
        const message = errorMessage(e);
        decision = {
          verdict: "ask",
          reasons: [`policy evaluation failed: ${message}`],
          source: "policy-error",
        };
        error ??= message;
      }
    }

    // A scheme such as javascript: or file: is never quietly allowed, even if
    // the model calls it read-only. The policy layer may add its own rule too.
    if (options.forceAsk && decision.verdict !== "block") {
      decision = {
        verdict: "ask",
        reasons: [...decision.reasons, options.forceAsk],
        source: decision.source,
      };
    }

    // Check the element once the model has answered, before a human is asked.
    let changed = handle && fingerprint ? await this.revalidate(handle, fingerprint) : null;
    if (changed) {
      decision = { verdict: "block", reasons: [...decision.reasons, changed], source: "hard-rule" };
    }

    let humanApproved: boolean | null = null;
    if (decision.verdict === "ask") {
      try {
        humanApproved = await (this.#opts.approver ?? denyAll)({
          task: this.#opts.task,
          action,
          decision,
          page,
        });
      } catch (e) {
        error ??= `approver failed: ${errorMessage(e)}`;
        humanApproved = false;
      }

      // A human may have taken a while. Re-check the same handle after the
      // answer, so approval applies to the element the human was shown.
      if (humanApproved && handle && fingerprint) {
        changed = await this.revalidate(handle, fingerprint);
        if (changed) {
          decision = {
            verdict: "block",
            reasons: [...decision.reasons, changed],
            source: "hard-rule",
          };
        }
      }
    }

    const proceed =
      decision.verdict === "allow" || (decision.verdict === "ask" && humanApproved === true);

    const base = {
      task: this.#opts.task,
      action: describeAction(action),
      page: { url: page.url, title: page.title },
      stateSha256: createHash("sha256").update(state).digest("hex"),
      backend: evaluation?.backend ?? null,
      model: evaluation?.backend ?? null,
      policy: { ...policy },
      latencyMs: evaluation ? Math.round(evaluation.latencyMs) : null,
      answers: evaluation?.answers ?? null,
      decision,
      humanApproved,
      humanApprovedBy: humanApproved === true ? (this.#opts.approverId ?? null) : null,
    };

    const intent: EvidenceRecord = {
      at: new Date().toISOString(),
      phase: "intent",
      ...base,
      executed: false,
      ...(error ? { error } : {}),
    };
    // If this write fails, the run fails before the action: no evidence, no
    // side effect.
    await this.log(intent);

    let executed = false;
    let runError: unknown;
    if (proceed) {
      try {
        await run();
        executed = true;
      } catch (e) {
        runError = e;
      }
    }

    const outcome: EvidenceRecord = {
      at: new Date().toISOString(),
      phase: "outcome",
      ...base,
      executed,
      ...(runError ? { error: errorMessage(runError) } : error ? { error } : {}),
    };
    try {
      await this.log(outcome);
    } catch (e) {
      // The action may already have run. Do not replace the real result with
      // an audit error; report it and keep the gate's semantics.
      console.error(`stopline: could not append evidence: ${errorMessage(e)}`);
    }

    // A monitoring callback must not turn a block into a success, or hide the
    // exception we are about to throw.
    try {
      this.#opts.onDecision?.(outcome);
    } catch {
      // Ignore observer failures.
    }

    if (runError) throw runError;
    if (!proceed) throw new StoppedByGate(action, decision);
  }

  private log(record: EvidenceRecord): Promise<void> {
    const path = this.#opts.evidencePath;
    if (!path) return Promise.resolve();
    const line = JSON.stringify(record) + "\n";
    // Chain writes so records land in order even when actions overlap.
    const write = this.#logQueue.then(() => appendFile(path, line, "utf8"));
    this.#logQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }
}
