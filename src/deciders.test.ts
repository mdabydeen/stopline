import { test } from "node:test";
import assert from "node:assert/strict";
import { KeywordDecider, normaliseAnswers } from "./deciders.ts";
import { GATE_QUESTIONS, renderState } from "./questions.ts";
import { CASES } from "../eval/cases.ts";

test("keyword task fit ignores a navigation path unrelated to the visible action", async () => {
  const c = CASES.find((it) => it.id === "repo-05")!;
  const ev = await new KeywordDecider().evaluate(renderState(c.task, c.action, c.page), GATE_QUESTIONS);
  assert.equal(ev.answers.servesTask.type, "boolean");
  assert.equal(ev.answers.servesTask.probability, 0.5);
});

test("keyword task fit does not use a product-name substring as task evidence", async () => {
  const c = CASES.find((it) => it.id === "srch-02")!;
  const ev = await new KeywordDecider().evaluate(renderState(c.task, c.action, c.page), GATE_QUESTIONS);
  assert.equal(ev.answers.servesTask.type, "boolean");
  assert.equal(ev.answers.servesTask.probability, 0.5);
});

test("a choice answer carries the distribution confidence on its option", async () => {
  const c = CASES.find((it) => it.id === "repo-05")!;
  const ev = await new KeywordDecider().evaluate(renderState(c.task, c.action, c.page), GATE_QUESTIONS);
  const effect = ev.answers.effect;
  assert.equal(effect.type, "choice");
  const conf = (effect as { confidence?: number }).confidence;
  assert.equal(typeof conf, "number");
  assert.ok(conf! > 0, "confident effect has positive confidence");
});

// normaliseAnswers is the single total parse path over the backends' wire shapes.
test("normaliseAnswers resolves Jev {choice,probabilities} and Laya bool-as-number", () => {
  const out = normaliseAnswers(
    { effect: { choice: "read_only", probabilities: { read_only: 0.9, reversible_change: 0.1 } }, n: 0.7 },
    {
      effect: { type: "choice", instructions: "", criteria: { read_only: "r", reversible_change: "c" } },
      n: { type: "boolean", instructions: "" },
    },
  );
  assert.deepEqual(out,
    { effect: { type: "choice", choice: "read_only", probabilities: { read_only: 0.9, reversible_change: 0.1 }, confidence: 0.9 }, n: { type: "boolean", probability: 0.7 } });
});

test("normaliseAnswers falls back to argmax when the chosen option is missing", () => {
  const out = normaliseAnswers(
    { effect: { probabilities: { reversible_change: 0.6, read_only: 0.4 } } },
    { effect: { type: "choice", instructions: "", criteria: { reversible_change: "c", read_only: "r" } } },
  );
  assert.equal(out.effect.type, "choice");
  assert.equal((out.effect as { choice: string }).choice, "reversible_change");
  assert.equal((out.effect as { confidence: number }).confidence, 0.6);
});
