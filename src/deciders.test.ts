import { test } from "node:test";
import assert from "node:assert/strict";
import { KeywordDecider } from "./deciders.ts";
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
