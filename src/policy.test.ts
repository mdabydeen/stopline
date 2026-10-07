import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./policy.ts";
import type { Answer, PageContext, ProposedAction } from "./types.ts";

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
