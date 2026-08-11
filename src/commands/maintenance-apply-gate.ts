/**
 * Bulk maintenance has a dry-run CLI surface only until it is bound to a
 * Gateway-owned operator action. The beta.7 approval protocol can resolve
 * approvals for registered actions, but it exposes no public API to create
 * and redeem a one-use approval for an arbitrary local CLI mutation.
 */
export function rejectUnapprovedMaintenanceApply(apply: boolean | undefined): void {
  if (!apply) {
    return;
  }
  throw new Error(
    "Maintenance --apply is unavailable: beta.7 has no public operator-approved maintenance action for this local CLI. Run the dry-run without --apply.",
  );
}
