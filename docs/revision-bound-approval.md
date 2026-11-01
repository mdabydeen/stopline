# Revision-bound approval

An approval is evidence about a particular proposal. If the proposal changes, the approval needs to be reviewed again.

Stopline's [`checkRevisionApproval`](../src/revisionGate.ts) helper compares three identifiers:

- the action being approved;
- the proposed revision; and
- the captured state on which the approval was made.

When all three match, the helper accepts the approval. If the revision changes from `commit-a` to `commit-b`, it rejects the approval with `approval revision does not match proposal`. It also rejects a changed state identifier or a different action identifier.

Blank input is rejected rather than treated as a wildcard: an empty or whitespace-only `actionId`, `revision`, or `stateHash` on either the proposal or the approval is refused, as is a blank `approvedBy`.

## Optional checks

A third argument adds checks the surrounding system may need:

```ts
checkRevisionApproval(proposal, approval, {
  // Reject an approver that is identified only by a string.
  isApproverAllowed: (approvedBy) => allowedApprovers.has(approvedBy),
  // Reject stale approvals. `approvedAt` is then required.
  maxAgeMs: 5 * 60 * 1000,
  // Optional clock override for tests; defaults to Date.now().
  now: Date.parse("2026-05-01T12:00:00.000Z"),
});
```

With `maxAgeMs` set, the approval must carry a parseable ISO-8601 `approvedAt` timestamp that is not in the future and is no older than the window. A future-dated timestamp is treated as invalid. Without `isApproverAllowed`, an approver is accepted on the strength of the string alone; without `maxAgeMs`, `approvedAt` is ignored.

The default call therefore does **not** authenticate the approver or enforce freshness. Those checks depend on the surrounding system: it has to supply an authorization hook, a trusted clock, and a freshness window.

Run the example locally:

```bash
npm ci
npm run demo:revision
```

The example is a small, testable building block for a delivery contract. It does not calculate repository hashes, authenticate approvers by itself, enforce a merge control, or prove that a surrounding workflow cannot bypass it. The test suite covers matching identifiers, mismatched action/revision/state, blank identifiers and approvers, an unauthorized approver, and an expired approval.
