import type {
  Answer,
  ChoiceAnswer,
  Decision,
  PageContext,
  ProposedAction,
  Verdict,
} from "./types.ts";
import { isSensitiveField } from "./questions.ts";

// All thresholds in one place so a reviewer can read the whole policy.
export const DEFAULT_POLICY = {
  // Page text that addresses the agent quarantines the page.
  injectionBlockAt: 0.5,
  // Off-task actions below this are refused outright.
  offTaskBlockBelow: 0.3,
  // On-task probability needed to run without a human.
  onTaskAllowAt: 0.8,
  // Probability on the top effect class needed to run without a human.
  effectConfidenceAllowAt: 0.8,
  // If this much probability sits on the two high-impact classes, ask,
  // even when the top class is benign. Argmax alone hides the tail.
  highImpactMassAskAt: 0.2,
} as const;

// Same keys and defaults, but every value is a plain number so a caller can
// override one threshold without widening the whole object to literal types.
export type Policy = { [K in keyof typeof DEFAULT_POLICY]: number };

const EFFECT_CHOICES = new Set([
  "read_only",
  "reversible_change",
  "public_or_irreversible",
  "credentials_or_money",
]);
const HIGH_IMPACT = ["public_or_irreversible", "credentials_or_money"] as const;
const DANGEROUS_PROTOCOLS = new Set(["javascript:", "data:", "file:", "blob:"]);

const RANK: Record<Verdict, number> = { allow: 0, ask: 1, block: 2 };
const stricter = (a: Verdict, b: Verdict): Verdict =>
  RANK[a] >= RANK[b] ? a : b;

function isHttp(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function resolveUrl(value: string, base: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function pageOrigin(page: PageContext): string | null {
  try {
    return new URL(page.url).origin;
  } catch {
    return null;
  }
}

// Layer 1. Deterministic rules from DOM facts. No model involved, so the
// model can add friction on top of these but can never remove it.
export function hardRules(
  action: ProposedAction,
  page: PageContext,
): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  let verdict: Verdict = "allow";
  const add = (v: Verdict, reason: string) => {
    verdict = stricter(verdict, v);
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  const el = action.element ?? {};
  if (action.kind === "fill" && isSensitiveField(el)) {
    if ((el.inputType ?? "").toLowerCase() === "password") {
      add("ask", "fills a password field");
    } else if (el.autocomplete) {
      add("ask", `fills a field marked autocomplete=${el.autocomplete}`);
    } else {
      add("ask", "fills a sensitive field");
    }
  }

  // Enter in a credential field can submit the form just as a click can. Other
  // keys (navigation, editing) stay with the model rules.
  if (
    action.kind === "press" &&
    isSensitiveField(el) &&
    /^(enter|numpadenter)$/i.test(action.value ?? "")
  ) {
    add("ask", "presses Enter in a sensitive field");
  }

  const origin = pageOrigin(page);

  const checkHref = (label: string) => {
    if (!el.href) return;
    const target = resolveUrl(el.href, page.url);
    if (!target) {
      add("ask", `${label} target is not a valid URL`);
    } else if (DANGEROUS_PROTOCOLS.has(target.protocol)) {
      add("block", `${label} target uses ${target.protocol} URL`);
    } else if (!isHttp(target)) {
      add("ask", `${label} target uses ${target.protocol} URL`);
    } else if (!origin || target.origin !== origin) {
      add("ask", `${label} navigates off-origin to ${target.origin}`);
    }
  };

  const checkForm = (label: string) => {
    if (!el.formAction) return;
    const target = resolveUrl(el.formAction, page.url);
    if (!target) {
      add("ask", `${label} form action is not a valid URL`);
    } else if (DANGEROUS_PROTOCOLS.has(target.protocol)) {
      add("block", `${label} form action uses ${target.protocol} URL`);
    } else if (!isHttp(target)) {
      add("ask", `${label} form action uses ${target.protocol} URL`);
    } else if (!origin || target.origin !== origin) {
      add("ask", `${label} submits a form off-origin to ${target.origin}`);
    }
  };

  if (action.kind === "click" || action.kind === "press") {
    // Enter can submit a form just as a click can, so both kinds inspect both
    // targets. A dangerous scheme is a hard block rather than an ask.
    checkHref(action.kind);
    checkForm(action.kind);
  }

  if (action.kind === "goto" && action.value) {
    const target = resolveUrl(action.value, page.url);
    if (!target) {
      add("ask", "navigation target is not a valid URL");
    } else if (DANGEROUS_PROTOCOLS.has(target.protocol)) {
      add("block", `navigation target uses ${target.protocol} URL`);
    } else if (!isHttp(target)) {
      add("ask", `navigation target uses ${target.protocol} URL`);
    } else if (!origin || target.origin !== origin) {
      add("ask", `navigates off-origin to ${target.origin}`);
    }
  }

  return { verdict, reasons };
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type ModelAnswers = {
  effect: Pick<ChoiceAnswer, "choice" | "probabilities" | "confidence">;
  servesTask: number;
  pageInstructsAgent: number;
};

// Defensive validation for deciders that bypass normaliseAnswers (custom or
// buggy implementations). A malformed answer fails closed to a human; it must
// never fall through to an allow.
function validateModelAnswers(
  answers: Record<string, Answer>,
): { ok: true; value: ModelAnswers } | { ok: false; reason: string } {
  const root = asRecord(answers);
  if (!root) return { ok: false, reason: "answers are missing" };

  const effect = asRecord(root.effect);
  if (!effect) return { ok: false, reason: "effect is missing or not an object" };
  if (effect.type !== "choice") {
    return { ok: false, reason: "effect is not a choice answer" };
  }
  if (typeof effect.choice !== "string" || !EFFECT_CHOICES.has(effect.choice)) {
    return {
      ok: false,
      reason: `effect choice ${JSON.stringify(effect.choice)} is not a known effect`,
    };
  }
  if (!isUnitNumber(effect.confidence)) {
    return {
      ok: false,
      reason: "effect confidence must be a finite number in [0,1]",
    };
  }

  const probsRaw = asRecord(effect.probabilities);
  if (!probsRaw) {
    return { ok: false, reason: "effect probabilities are missing or not an object" };
  }
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(probsRaw)) {
    if (!EFFECT_CHOICES.has(key)) {
      return {
        ok: false,
        reason: `effect probability key ${JSON.stringify(key)} is not a known effect`,
      };
    }
    if (!isUnitNumber(value)) {
      return {
        ok: false,
        reason: `effect probability ${key} must be a finite number in [0,1]`,
      };
    }
    probabilities[key] = value;
  }
  if (!Object.prototype.hasOwnProperty.call(probabilities, effect.choice)) {
    return {
      ok: false,
      reason: `effect is missing a probability for ${effect.choice}`,
    };
  }

  const booleanProbability = (
    key: "servesTask" | "pageInstructsAgent",
  ): number | null => {
    const answer = asRecord(root[key]);
    if (!answer || answer.type !== "boolean" || !isUnitNumber(answer.probability)) {
      return null;
    }
    return answer.probability;
  };

  const servesTask = booleanProbability("servesTask");
  if (servesTask === null) {
    return {
      ok: false,
      reason: "servesTask must be a boolean answer with a finite probability in [0,1]",
    };
  }
  const pageInstructsAgent = booleanProbability("pageInstructsAgent");
  if (pageInstructsAgent === null) {
    return {
      ok: false,
      reason:
        "pageInstructsAgent must be a boolean answer with a finite probability in [0,1]",
    };
  }

  return {
    ok: true,
    value: {
      effect: {
        choice: effect.choice,
        probabilities,
        confidence: effect.confidence,
      },
      servesTask,
      pageInstructsAgent,
    },
  };
}

// Layer 2. Turns calibrated probabilities into a verdict. This is where the
// authority lives, and it is ordinary code a reviewer can test.
export function modelRules(
  answers: Record<string, Answer>,
  policy: Policy = DEFAULT_POLICY,
): { verdict: Verdict; reasons: string[] } {
  const checked = validateModelAnswers(answers);
  if (!checked.ok) {
    return { verdict: "ask", reasons: [`invalid model answer: ${checked.reason}`] };
  }

  const { effect, servesTask: onTask, pageInstructsAgent: injected } = checked.value;
  // Confidence is the model's own mass on its chosen effect, carried on the answer.
  const confidence = effect.confidence;
  const highImpactMass = HIGH_IMPACT.reduce(
    (sum, k) => sum + (effect.probabilities[k] ?? 0),
    0,
  );

  if (injected >= policy.injectionBlockAt) {
    return {
      verdict: "block",
      reasons: [`page appears to instruct the agent (p=${injected.toFixed(2)})`],
    };
  }
  if (onTask < policy.offTaskBlockBelow) {
    return {
      verdict: "block",
      reasons: [`action does not serve the task (p on-task=${onTask.toFixed(2)})`],
    };
  }

  const reasons: string[] = [];
  if ((HIGH_IMPACT as readonly string[]).includes(effect.choice)) {
    reasons.push(`effect is ${effect.choice} (p=${confidence.toFixed(2)})`);
  } else if (highImpactMass >= policy.highImpactMassAskAt) {
    reasons.push(
      `top effect is ${effect.choice}, but ${highImpactMass.toFixed(2)} probability sits on high-impact effects`,
    );
  }
  if (onTask < policy.onTaskAllowAt) {
    reasons.push(`on-task probability ${onTask.toFixed(2)} is below ${policy.onTaskAllowAt}`);
  }
  if (confidence < policy.effectConfidenceAllowAt) {
    reasons.push(`effect confidence ${confidence.toFixed(2)} is below ${policy.effectConfidenceAllowAt}`);
  }
  return { verdict: reasons.length ? "ask" : "allow", reasons };
}

export function decide(
  action: ProposedAction,
  page: PageContext,
  answers: Record<string, Answer> | null,
  policy: Policy = DEFAULT_POLICY,
): Decision {
  const hard = hardRules(action, page);
  if (!answers) {
    // Model unavailable: fail closed to a human, never open.
    return {
      verdict: stricter(hard.verdict, "ask"),
      reasons: [...hard.reasons, "no model answer available"],
      source: hard.verdict === "allow" ? "policy-default" : "hard-rule",
    };
  }
  const model = modelRules(answers, policy);
  const verdict = stricter(hard.verdict, model.verdict);
  const source =
    RANK[model.verdict] > RANK[hard.verdict] ? "model" : hard.verdict === "allow" ? "model" : "hard-rule";
  return { verdict, reasons: [...hard.reasons, ...model.reasons], source };
}
