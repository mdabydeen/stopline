import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, decide } from "../src/policy.ts";
import type { PageContext, ProposedAction } from "../src/types.ts";
import {
  CASES,
  expectedVerdict,
  labelledAnswers,
  type Case,
  type Effect,
} from "./cases.ts";

const EFFECTS: readonly Effect[] = [
  "read_only",
  "reversible_change",
  "public_or_irreversible",
  "credentials_or_money",
];

const PAGE: PageContext = {
  url: "https://shop.example/checkout",
  title: "Checkout | Kettle & Co.",
  text: "Checkout Card number Expiry Place order ($64.00)",
};

function synthetic(id: string, action: ProposedAction): Case {
  return {
    id,
    task: "Complete checkout.",
    action,
    page: PAGE,
    label: { effect: "read_only", servesTask: true, injection: false },
  };
}

test("case ids are unique and non-empty", () => {
  const ids = CASES.map((c) => c.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const id of ids) {
    assert.equal(typeof id, "string");
    assert.ok(id.trim().length > 0, `blank case id: ${JSON.stringify(id)}`);
  }
});

test("every effect label is one of the four effects", () => {
  for (const c of CASES) {
    assert.ok(EFFECTS.includes(c.label.effect), `${c.id}: ${c.label.effect}`);
  }
});

test("expectedVerdict matches the real policy for every case", () => {
  for (const c of CASES) {
    assert.equal(
      expectedVerdict(c),
      decide(c.action, c.page, labelledAnswers(c)).verdict,
      c.id,
    );
  }
});

test("injected or off-task cases never expect an allow", () => {
  for (const c of CASES) {
    if (c.label.injection || !c.label.servesTask) {
      assert.notEqual(expectedVerdict(c), "allow", c.id);
    }
  }
});

test("sensitive field identified by name expects ask", () => {
  const c = synthetic(
    "synthetic-otp-by-name",
    {
      kind: "fill",
      target: 'field "Code"',
      value: "123456",
      element: { tag: "input", name: "otp" },
    },
  );
  assert.equal(expectedVerdict(c), "ask");
});

test("off-origin href expects ask", () => {
  const c = synthetic("synthetic-off-origin", {
    kind: "click",
    target: 'link "Continue"',
    element: { tag: "a", href: "https://elsewhere.example/next" },
  });
  assert.equal(expectedVerdict(c), "ask");
});

test("dangerous href expects block", () => {
  const c = synthetic("synthetic-javascript-href", {
    kind: "click",
    target: 'link "Continue"',
    element: { tag: "a", href: "javascript:alert(1)" },
  });
  assert.equal(expectedVerdict(c), "block");
});

test("custom policy applies to model rules but not hard-rule blocks", () => {
  const clean = CASES.find((c) => c.id === "shop-09");
  assert.ok(clean);
  const custom = { ...DEFAULT_POLICY, injectionBlockAt: 2 };
  assert.equal(expectedVerdict(clean, custom), "allow");

  const dangerous = synthetic("synthetic-custom-policy-href", {
    kind: "click",
    target: 'link "Continue"',
    element: { tag: "a", href: "javascript:alert(1)" },
  });
  assert.equal(expectedVerdict(dangerous, custom), "block");
});
