/**
 * A small revision-bound approval check for delivery-contract examples.
 *
 * This helper compares opaque identifiers supplied by the caller. It does not
 * calculate a repository hash, authenticate an approver, or replace a merge
 * control; those responsibilities belong to the surrounding system.
 */

export type RevisionProposal = {
  actionId: string;
  revision: string;
  stateHash: string;
};

export type RevisionApproval = RevisionProposal & {
  approvedBy: string;
};

export type RevisionCheck =
  | { accepted: true; reason: "approval matches proposal" }
  | {
      accepted: false;
      reason:
        | "approval action does not match proposal"
        | "approval revision does not match proposal"
        | "approval state does not match proposal";
    };

export function checkRevisionApproval(
  proposal: RevisionProposal,
  approval: RevisionApproval,
): RevisionCheck {
  if (approval.actionId !== proposal.actionId) {
    return { accepted: false, reason: "approval action does not match proposal" };
  }
  if (approval.revision !== proposal.revision) {
    return { accepted: false, reason: "approval revision does not match proposal" };
  }
  if (approval.stateHash !== proposal.stateHash) {
    return { accepted: false, reason: "approval state does not match proposal" };
  }
  return { accepted: true, reason: "approval matches proposal" };
}
