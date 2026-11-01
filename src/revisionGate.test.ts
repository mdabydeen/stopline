import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRevisionApproval, type RevisionApproval, type RevisionProposal } from "./revisionGate.ts";

const proposal: RevisionProposal = {
  actionId: "publish-change",
  revision: "commit-a",
  stateHash: "state-a",
};

const approval: RevisionApproval = {
  ...proposal,
  approvedBy: "reviewer@example.test",
};

const now = Date.parse("2026-05-01T12:00:00.000Z");

test("accepts an approval bound to the proposed revision and state", () => {
  assert.deepEqual(checkRevisionApproval(proposal, approval), {
    accepted: true,
    reason: "approval matches proposal",
  });
});

test("rejects an approval after the proposed revision changes", () => {
  const changed = { ...proposal, revision: "commit-b" };
  assert.deepEqual(checkRevisionApproval(changed, approval), {
    accepted: false,
    reason: "approval revision does not match proposal",
  });
});

test("rejects an approval after the captured state changes", () => {
  const changed = { ...proposal, stateHash: "state-b" };
  assert.deepEqual(checkRevisionApproval(changed, approval), {
    accepted: false,
    reason: "approval state does not match proposal",
  });
});

test("rejects an approval for a different action", () => {
  const changed = { ...proposal, actionId: "delete-change" };
  assert.deepEqual(checkRevisionApproval(changed, approval), {
    accepted: false,
    reason: "approval action does not match proposal",
  });
});

test("rejects a proposal with an empty or blank identifier", () => {
  const cases: Array<[keyof RevisionProposal, string]> = [
    ["actionId", ""],
    ["actionId", "   "],
    ["revision", ""],
    ["revision", "\t"],
    ["stateHash", ""],
    ["stateHash", " \n "],
  ];

  for (const [field, value] of cases) {
    const blankProposal = { ...proposal, [field]: value };
    const matchingApproval = { ...approval, [field]: value };
    assert.deepEqual(checkRevisionApproval(blankProposal, matchingApproval), {
      accepted: false,
      reason: "proposal identifiers must not be empty",
    });
  }
});

test("rejects an approval with an empty or blank identifier", () => {
  const cases: Array<[keyof RevisionProposal, string]> = [
    ["actionId", ""],
    ["actionId", "  "],
    ["revision", ""],
    ["revision", " "],
    ["stateHash", ""],
    ["stateHash", "\u00a0"],
  ];

  for (const [field, value] of cases) {
    const blankApproval = { ...approval, [field]: value };
    assert.deepEqual(checkRevisionApproval(proposal, blankApproval), {
      accepted: false,
      reason: "approval identifiers must not be empty",
    });
  }
});

test("rejects an approval whose three identifiers are all empty, even when the proposal matches", () => {
  const blankProposal: RevisionProposal = { actionId: "", revision: "", stateHash: "" };
  assert.deepEqual(checkRevisionApproval(blankProposal, { ...blankProposal, approvedBy: "reviewer@example.test" }), {
    accepted: false,
    reason: "proposal identifiers must not be empty",
  });
});

test("rejects an approval without an approver", () => {
  for (const approvedBy of ["", " ", "\t\n"]) {
    assert.deepEqual(checkRevisionApproval(proposal, { ...approval, approvedBy }), {
      accepted: false,
      reason: "approver must not be empty",
    });
  }
});

test("rejects an approver that the authorization hook refuses", () => {
  const result = checkRevisionApproval(proposal, approval, {
    isApproverAllowed: (approvedBy) => approvedBy === "maintainer@example.test",
  });
  assert.deepEqual(result, { accepted: false, reason: "approver is not authorized" });
});

test("accepts an approver that the authorization hook allows", () => {
  const seen: string[] = [];
  const result = checkRevisionApproval(proposal, approval, {
    isApproverAllowed: (approvedBy) => {
      seen.push(approvedBy);
      return approvedBy === "reviewer@example.test";
    },
  });
  assert.deepEqual(result, { accepted: true, reason: "approval matches proposal" });
  assert.deepEqual(seen, ["reviewer@example.test"]);
});

test("rejects an approval older than maxAgeMs", () => {
  const result = checkRevisionApproval(
    proposal,
    { ...approval, approvedAt: new Date(now - 60 * 60 * 1000).toISOString() },
    { maxAgeMs: 5 * 60 * 1000, now },
  );
  assert.deepEqual(result, { accepted: false, reason: "approval has expired" });
});

test("accepts an approval inside the maxAgeMs window", () => {
  const result = checkRevisionApproval(
    proposal,
    { ...approval, approvedAt: new Date(now - 60 * 1000).toISOString() },
    { maxAgeMs: 5 * 60 * 1000, now },
  );
  assert.deepEqual(result, { accepted: true, reason: "approval matches proposal" });
});

test("rejects a missing or unparseable approvedAt when maxAgeMs is set", () => {
  const options = { maxAgeMs: 5 * 60 * 1000, now };

  assert.deepEqual(checkRevisionApproval(proposal, approval, options), {
    accepted: false,
    reason: "approval timestamp is missing/invalid",
  });

  for (const approvedAt of ["", "   ", "not-a-date", "2026-13-45T99:99:99Z"]) {
    assert.deepEqual(checkRevisionApproval(proposal, { ...approval, approvedAt }, options), {
      accepted: false,
      reason: "approval timestamp is missing/invalid",
    });
  }
});

test("rejects an approval timestamped in the future when maxAgeMs is set", () => {
  const result = checkRevisionApproval(
    proposal,
    { ...approval, approvedAt: new Date(now + 60 * 1000).toISOString() },
    { maxAgeMs: 5 * 60 * 1000, now },
  );
  assert.deepEqual(result, { accepted: false, reason: "approval timestamp is missing/invalid" });
});

test("ignores approvedAt when no maxAgeMs is supplied", () => {
  assert.deepEqual(checkRevisionApproval(proposal, approval), {
    accepted: true,
    reason: "approval matches proposal",
  });
  assert.deepEqual(
    checkRevisionApproval(proposal, { ...approval, approvedAt: "2000-01-01T00:00:00.000Z" }),
    { accepted: true, reason: "approval matches proposal" },
  );
});

test("rejects an invalid maxAgeMs", () => {
  for (const maxAgeMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => checkRevisionApproval(proposal, approval, { maxAgeMs }), TypeError);
  }
});
