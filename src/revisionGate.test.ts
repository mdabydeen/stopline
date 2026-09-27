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
