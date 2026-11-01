/**
 * A small revision-bound approval check for delivery-contract examples.
 *
 * This helper compares opaque identifiers supplied by the caller. It does not
 * calculate a repository hash, authenticate an approver by itself, or replace a
 * merge control; those responsibilities belong to the surrounding system.
 *
 * Defaults stay deliberately permissive for existing callers: without options
 * the check compares identifiers and requires a non-empty `approvedBy`.
 * Callers that need more authority can pass an authorization hook and a
 * freshness window through the optional third argument.
 */

export type RevisionProposal = {
  actionId: string;
  revision: string;
  stateHash: string;
};

export type RevisionApproval = RevisionProposal & {
  approvedBy: string;
  /** ISO-8601 timestamp of when the approval was recorded. */
  approvedAt?: string;
};

export type RevisionCheck =
  | { accepted: true; reason: "approval matches proposal" }
  | {
      accepted: false;
      reason:
        | "proposal identifiers must not be empty"
        | "approval identifiers must not be empty"
        | "approver must not be empty"
        | "approval action does not match proposal"
        | "approval revision does not match proposal"
        | "approval state does not match proposal"
        | "approver is not authorized"
        | "approval has expired"
        | "approval timestamp is missing/invalid";
    };

export type RevisionCheckOptions = {
  /** Return false to reject an approver that matches by identifier only. */
  isApproverAllowed?: (approvedBy: string) => boolean;
  /** Current time in milliseconds since the epoch. Defaults to `Date.now()`. */
  now?: number;
  /**
   * Maximum accepted age of `approvedAt`, in milliseconds. When set,
   * `approvedAt` is required and must be a parseable, non-future timestamp.
   */
  maxAgeMs?: number;
};

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

function hasBlankIdentifier(candidate: RevisionProposal): boolean {
  return isBlank(candidate.actionId) || isBlank(candidate.revision) || isBlank(candidate.stateHash);
}

/**
 * Compare an approval against the proposal it claims to approve.
 *
 * Identifiers must be non-blank on both sides, `approvedBy` must be non-blank,
 * and the three identifiers must match exactly. Providing `isApproverAllowed`
 * or `maxAgeMs` adds authorization and replay/freshness checks; omitting both
 * keeps the plain identifier comparison.
 */
export function checkRevisionApproval(
  proposal: RevisionProposal,
  approval: RevisionApproval,
  options: RevisionCheckOptions = {},
): RevisionCheck {
  const { isApproverAllowed, now, maxAgeMs } = options;

  if (maxAgeMs !== undefined && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)) {
    throw new TypeError("maxAgeMs must be a finite, non-negative number of milliseconds");
  }

  if (hasBlankIdentifier(proposal)) {
    return { accepted: false, reason: "proposal identifiers must not be empty" };
  }
  if (hasBlankIdentifier(approval)) {
    return { accepted: false, reason: "approval identifiers must not be empty" };
  }
  if (isBlank(approval.approvedBy)) {
    return { accepted: false, reason: "approver must not be empty" };
  }

  if (approval.actionId !== proposal.actionId) {
    return { accepted: false, reason: "approval action does not match proposal" };
  }
  if (approval.revision !== proposal.revision) {
    return { accepted: false, reason: "approval revision does not match proposal" };
  }
  if (approval.stateHash !== proposal.stateHash) {
    return { accepted: false, reason: "approval state does not match proposal" };
  }

  if (isApproverAllowed && !isApproverAllowed(approval.approvedBy)) {
    return { accepted: false, reason: "approver is not authorized" };
  }

  if (maxAgeMs !== undefined) {
    const approvedAt = approval.approvedAt === undefined ? Number.NaN : Date.parse(approval.approvedAt);
    const currentTime = now ?? Date.now();

    if (!Number.isFinite(approvedAt) || !Number.isFinite(currentTime) || approvedAt > currentTime) {
      return { accepted: false, reason: "approval timestamp is missing/invalid" };
    }
    if (currentTime - approvedAt > maxAgeMs) {
      return { accepted: false, reason: "approval has expired" };
    }
  }

  return { accepted: true, reason: "approval matches proposal" };
}
