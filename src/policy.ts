import type {
  Answer,
  BooleanAnswer,
  ChoiceAnswer,
  Decision,
  PageContext,
  ProposedAction,
  Verdict,
} from "./types.ts";

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

export type Policy = typeof DEFAULT_POLICY;

const HIGH_IMPACT = ["public_or_irreversible", "credentials_or_money"] as const;
const SECRET_AUTOCOMPLETE =
  /^(cc-|current-password|new-password|one-time-code)/i;

const RANK: Record<Verdict, number> = { allow: 0, ask: 1, block: 2 };
const stricter = (a: Verdict, b: Verdict): Verdict =>
  RANK[a] >= RANK[b] ? a : b;

// Layer 1. Deterministic rules from DOM facts. No model involved, so the
// model can add friction on top of these but can never remove it.
export function hardRules(
  action: ProposedAction,
  page: PageContext,
): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  const el = action.element ?? {};
  if (action.kind === "fill") {
    if (el.inputType === "password") reasons.push("fills a password field");
    if (el.autocomplete && SECRET_AUTOCOMPLETE.test(el.autocomplete)) {
      reasons.push(`fills a field marked autocomplete=${el.autocomplete}`);
    }
  }
  if (action.kind === "goto" && action.value) {
    try {
      const from = new URL(page.url).origin;
      const to = new URL(action.value, page.url).origin;
      if (from !== to) reasons.push(`navigates off-origin to ${to}`);
    } catch {
      reasons.push("navigation target is not a valid URL");
    }
  }
  return { verdict: reasons.length ? "ask" : "allow", reasons };
}

// Layer 2. Turns calibrated probabilities into a verdict. This is where the
// authority lives, and it is ordinary code a reviewer can test.
export function modelRules(
  answers: Record<string, Answer>,
  policy: Policy = DEFAULT_POLICY,
): { verdict: Verdict; reasons: string[] } {
  const effect = answers.effect as ChoiceAnswer;
  const onTask = (answers.servesTask as BooleanAnswer).probability;
  const injected = (answers.pageInstructsAgent as BooleanAnswer).probability;
  const pTop = effect.probabilities[effect.choice] ?? 0;
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
    reasons.push(`effect is ${effect.choice} (p=${pTop.toFixed(2)})`);
  } else if (highImpactMass >= policy.highImpactMassAskAt) {
    reasons.push(
      `top effect is ${effect.choice}, but ${highImpactMass.toFixed(2)} probability sits on high-impact effects`,
    );
  }
  if (onTask < policy.onTaskAllowAt) {
    reasons.push(`on-task probability ${onTask.toFixed(2)} is below ${policy.onTaskAllowAt}`);
  }
  if (pTop < policy.effectConfidenceAllowAt) {
    reasons.push(`effect confidence ${pTop.toFixed(2)} is below ${policy.effectConfidenceAllowAt}`);
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
