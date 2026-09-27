# Revision-bound approval

An approval is evidence about a particular proposal. If the proposal changes, the approval needs to be reviewed again.

Stopline's [`checkRevisionApproval`](../src/revisionGate.ts) helper compares three identifiers:

- the action being approved;
- the proposed revision; and
- the captured state on which the approval was made.

When all three match, the helper accepts the approval. If the revision changes from `commit-a` to `commit-b`, it rejects the approval with `approval revision does not match proposal`. It also rejects a changed state identifier or a different action identifier.

Run the example locally:

```bash
npm install
npm run demo:revision
```

The example is a small, testable building block for a delivery contract. It does not calculate repository hashes, authenticate approvers, enforce a merge control, or prove that a surrounding workflow cannot bypass it. The complete test suite covers the matching and rejection cases.
