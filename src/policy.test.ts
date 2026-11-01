import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, decide, type Policy } from "./policy.ts";
import type { Answer, ChoiceAnswer, PageContext, ProposedAction } from "./types.ts";

const page: PageContext = { url: "https://shop.example/p", title: "Product", text: "Add to cart" };
const click: ProposedAction = { kind: "click", target: 'button "Add to cart"' };

function answers(effect: Record<string, number>, onTask: number, injected: number): Record<string, Answer> {
  const entries = Object.entries(effect).sort((a, b) => b[1] - a[1]);
  const choice = entries[0][0];
  return {
    effect: { type: "choice", choice, probabilities: effect, confidence: entries[0][1] },
    servesTask: { type: "boolean", probability: onTask },
    pageInstructsAgent: { type: "boolean", probability: injected },
  };
}

const clean = () => answers({ read_only: 0.99 }, 0.99, 0.01);

test("confident, on-task, reversible action is allowed", () => {
  const d = decide(click, page, answers({ reversible_change: 0.95, read_only: 0.05 }, 0.93, 0.02));
  assert.equal(d.verdict, "allow");
});

test("injection on the page blocks even a harmless action", () => {
  const d = decide(click, page, answers({ read_only: 0.99 }, 0.95, 0.7));
  assert.equal(d.verdict, "block");
});

test("off-task action is blocked", () => {
  const d = decide(click, page, answers({ read_only: 0.99 }, 0.1, 0.01));
  assert.equal(d.verdict, "block");
});

test("high-impact tail probability escalates a benign argmax", () => {
  const d = decide(click, page, answers({ reversible_change: 0.7, public_or_irreversible: 0.25, read_only: 0.05 }, 0.95, 0.01));
  assert.equal(d.verdict, "ask");
});

test("password fill asks a human even when the model says read_only", () => {
  const fill: ProposedAction = { kind: "fill", target: 'field "Password"', value: "x", element: { inputType: "password" } };
  const d = decide(fill, page, answers({ read_only: 0.99 }, 0.99, 0.0));
  assert.equal(d.verdict, "ask");
  assert.equal(d.source, "hard-rule");
});

test("off-origin navigation asks a human", () => {
  const go: ProposedAction = { kind: "goto", target: "address bar", value: "https://elsewhere.example/" };
  const d = decide(go, page, answers({ read_only: 0.99 }, 0.99, 0.0));
  assert.equal(d.verdict, "ask");
});

test("no model answer fails closed to a human", () => {
  const d = decide(click, page, null);
  assert.equal(d.verdict, "ask");
});

test("low effect confidence on a benign action asks a human", () => {
  // Top class is benign and no high-impact mass, but the model's stated mass on
  // its chosen effect (0.60) is below effectConfidenceAllowAt (0.80) -> ask.
  const d = decide(click, page, answers({ reversible_change: 0.6, read_only: 0.4 }, 0.95, 0.01));
  assert.equal(d.verdict, "ask");
});

test("a custom policy with different thresholds typechecks and changes the verdict", () => {
  const strict: Policy = { ...DEFAULT_POLICY, onTaskAllowAt: 0.9 };
  const d = decide(click, page, answers({ read_only: 0.99 }, 0.85, 0.01), strict);
  assert.equal(d.verdict, "ask");
  assert.match(d.reasons.join("; "), /below 0\.9/);
});

test("pressing Enter in a sensitive field asks a human", () => {
  const press: ProposedAction = {
    kind: "press",
    target: 'field "Password"',
    value: "Enter",
    element: { tag: "input", inputType: "password" },
  };
  const d = decide(press, page, clean());
  assert.equal(d.verdict, "ask");
  assert.equal(d.source, "hard-rule");
  assert.match(d.reasons.join("; "), /Enter in a sensitive field/);
});

test("sensitive fields are detected by name and label, not only autocomplete", () => {
  const byName: ProposedAction = {
    kind: "fill",
    target: 'field "Card number"',
    value: "4111111111111111",
    element: { tag: "input", inputType: "text", name: "card_number" },
  };
  const byLabel: ProposedAction = {
    kind: "fill",
    target: 'field "One-time code"',
    value: "123456",
    element: { tag: "input", inputType: "text", label: "One-time code" },
  };
  for (const action of [byName, byLabel]) {
    const d = decide(action, page, clean());
    assert.equal(d.verdict, "ask");
    assert.equal(d.source, "hard-rule");
    assert.match(d.reasons.join("; "), /sensitive field/);
  }
});

test("an off-origin link click asks a human", () => {
  const link: ProposedAction = {
    kind: "click",
    target: 'link "Checkout"',
    element: { tag: "a", href: "https://elsewhere.example/checkout" },
  };
  const d = decide(link, page, clean());
  assert.equal(d.verdict, "ask");
  assert.match(d.reasons.join("; "), /navigates off-origin to https:\/\/elsewhere\.example/);
});

test("an off-origin form action asks a human", () => {
  const submit: ProposedAction = {
    kind: "click",
    target: 'button "Pay"',
    element: { tag: "button", formAction: "https://pay.example/charge" },
  };
  const d = decide(submit, page, clean());
  assert.equal(d.verdict, "ask");
  assert.match(d.reasons.join("; "), /submits a form off-origin to https:\/\/pay\.example/);
});

test("a javascript: link is hard-blocked", () => {
  const link: ProposedAction = {
    kind: "click",
    target: 'link "Win a prize"',
    element: { tag: "a", href: "javascript:alert(document.cookie)" },
  };
  const d = decide(link, page, clean());
  assert.equal(d.verdict, "block");
  assert.match(d.reasons.join("; "), /click target uses javascript: URL/);
});

test("a same-origin http link is allowed with clean model answers", () => {
  const link: ProposedAction = {
    kind: "click",
    target: 'link "Product details"',
    element: { tag: "a", href: "https://shop.example/p/details" },
  };
  const d = decide(link, page, clean());
  assert.equal(d.verdict, "allow");
});

test("goto file: is hard-blocked", () => {
  const go: ProposedAction = { kind: "goto", target: "address bar", value: "file:///etc/passwd" };
  const d = decide(go, page, clean());
  assert.equal(d.verdict, "block");
  assert.match(d.reasons.join("; "), /navigation target uses file: URL/);
});

test("goto to the same origin is allowed with clean model answers", () => {
  const go: ProposedAction = { kind: "goto", target: "address bar", value: "https://shop.example/checkout" };
  const d = decide(go, page, clean());
  assert.equal(d.verdict, "allow");
});

test("an unknown effect choice asks a human, never allows", () => {
  const a = answers({ read_only: 0.99 }, 0.95, 0.01);
  a.effect = {
    type: "choice",
    choice: "harmless",
    probabilities: { harmless: 0.99 },
    confidence: 0.99,
  } as unknown as ChoiceAnswer;
  const d = decide(click, page, a);
  assert.equal(d.verdict, "ask");
  assert.match(d.reasons.join("; "), /invalid model answer/);
});

test("non-finite and out-of-range model numbers ask a human", () => {
  const nonFiniteConfidence = answers({ read_only: 0.99 }, 0.95, 0.01);
  (nonFiniteConfidence.effect as ChoiceAnswer).confidence = Number.NaN;

  const infiniteTask = answers({ read_only: 0.99 }, 0.95, 0.01);
  (infiniteTask.servesTask as { probability: number }).probability = Infinity;

  const negativeInjection = answers({ read_only: 0.99 }, 0.95, 0.01);
  (negativeInjection.pageInstructsAgent as { probability: number }).probability = -0.01;

  const outOfRangeProbability = answers({ read_only: 1.5 }, 0.95, 0.01);

  for (const a of [nonFiniteConfidence, infiniteTask, negativeInjection, outOfRangeProbability]) {
    const d = decide(click, page, a);
    assert.equal(d.verdict, "ask");
    assert.match(d.reasons.join("; "), /invalid model answer/);
  }
});

test("__proto__ and constructor cannot become effect choices", () => {
  for (const choice of ["__proto__", "constructor"]) {
    const a = answers({ read_only: 0.99 }, 0.95, 0.01);
    a.effect = {
      type: "choice",
      choice,
      probabilities: { read_only: 0.99 },
      confidence: 0.99,
    } as unknown as ChoiceAnswer;
    const d = decide(click, page, a);
    assert.equal(d.verdict, "ask");
    assert.match(d.reasons.join("; "), /invalid model answer/);
  }
});

test("negative high-impact probability is invalid rather than suppressing tail mass", () => {
  const a = answers(
    { read_only: 0.95, reversible_change: 0.1, public_or_irreversible: -0.05 },
    0.95,
    0.01,
  );
  const d = decide(click, page, a);
  assert.equal(d.verdict, "ask");
  assert.match(d.reasons.join("; "), /invalid model answer/);
});

test("missing keys and wrong answer shapes ask a human", () => {
  const missing = decide(click, page, {} as Record<string, Answer>);
  assert.equal(missing.verdict, "ask");
  assert.match(missing.reasons.join("; "), /invalid model answer/);

  const badBoolean = {
    ...answers({ read_only: 0.99 }, 0.95, 0.01),
    servesTask: 0.95,
  } as unknown as Record<string, Answer>;
  const d = decide(click, page, badBoolean);
  assert.equal(d.verdict, "ask");
  assert.match(d.reasons.join("; "), /invalid model answer/);
});
