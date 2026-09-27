import { checkRevisionApproval, type RevisionApproval, type RevisionProposal } from "../src/revisionGate.ts";

const approved: RevisionProposal = {
  actionId: "publish-change",
  revision: "commit-a",
  stateHash: "state-a",
};

const approval: RevisionApproval = {
  ...approved,
  approvedBy: "reviewer@example.test",
};

const changedRevision = { ...approved, revision: "commit-b" };

console.log(JSON.stringify({ proposal: approved, result: checkRevisionApproval(approved, approval) }, null, 2));
console.log(JSON.stringify({ proposal: changedRevision, result: checkRevisionApproval(changedRevision, approval) }, null, 2));
