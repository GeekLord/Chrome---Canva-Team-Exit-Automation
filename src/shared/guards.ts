/**
 * Safety guards. These encode the one rule the whole project exists to protect:
 *
 *   copy -> verify -> trash -> leave
 *
 * They are pure functions so they can be unit-tested directly and reused by the
 * reducer, the coordinator and the UI (which disables controls using the same
 * answers the engine will give).
 */

import type { ErrorCategory } from './errors';
import { isItemResolved, isVerified, itemsForTeam } from './factories';
import type { ConfirmationScope, DesignItem, ExecutionMode, RunJob } from './types';

export type GuardResult = { allowed: true } | { allowed: false; reason: string; category: ErrorCategory };

const ALLOWED: GuardResult = { allowed: true };

function deny(reason: string, category: ErrorCategory = 'unknown'): GuardResult {
  return { allowed: false, reason, category };
}

/* ----------------------------------------------------------------- modes --- */

export function modeAllowsCopy(mode: ExecutionMode): boolean {
  return mode !== 'dryRun';
}

export function modeAllowsVerify(mode: ExecutionMode): boolean {
  return mode === 'copyVerify' || mode === 'copyVerifyTrash' || mode === 'copyVerifyTrashLeave';
}

export function modeAllowsTrash(mode: ExecutionMode): boolean {
  return mode === 'copyVerifyTrash' || mode === 'copyVerifyTrashLeave';
}

export function modeAllowsLeave(mode: ExecutionMode): boolean {
  return mode === 'copyVerifyTrashLeave';
}

/** True for any mode that mutates Canva. Dry run must never reach an executor. */
export function modeIsMutating(mode: ExecutionMode): boolean {
  return mode !== 'dryRun';
}

/* ------------------------------------------------------------------ trash --- */

/**
 * An original may only be trashed when its copy landed, and (unless the user set
 * the explicit advanced override) when that copy was verified.
 */
export function canTrashItem(job: RunJob, item: DesignItem): GuardResult {
  if (!modeAllowsTrash(job.mode)) {
    return deny(`Run mode "${job.mode}" does not include trashing originals.`);
  }
  if (item.copyStatus !== 'copied') {
    return deny(
      `Copy status is "${item.copyStatus}", so the original stays put. Nothing is trashed without a completed copy.`,
      'copy_verification_failed',
    );
  }
  if (!isVerified(item)) {
    if (job.userOverrides.allowTrashWithoutVerification) return ALLOWED;
    return deny(
      'Copy was not verified. Enable the advanced override, verify manually, or skip the item.',
      'copy_verification_failed',
    );
  }
  return ALLOWED;
}

/* ------------------------------------------------------------------ leave --- */

/** Selected items that still need a decision before the team can be left. */
export function unresolvedItemsForTeam(job: RunJob, teamId: string): DesignItem[] {
  return itemsForTeam(job, teamId).filter((item) => item.selected && !isItemResolved(item));
}

export function canLeaveTeam(job: RunJob, teamId: string): GuardResult {
  if (!modeAllowsLeave(job.mode)) {
    return deny(`Run mode "${job.mode}" does not include leaving the team.`);
  }

  const team = job.sourceTeams.find((candidate) => candidate.internalId === teamId);
  if (!team) return deny(`Team ${teamId} is not part of this run.`);

  if (team.leaveSupportedState === 'blockedByPolicy') {
    return deny('Canva reports that leaving this team is not permitted for you.', 'leave_blocked_by_policy');
  }

  const unresolved = unresolvedItemsForTeam(job, teamId);
  if (unresolved.length > 0 && !job.userOverrides.allowLeaveWithUnresolvedItems) {
    return deny(
      `${unresolved.length} selected item(s) are still unresolved. Resolve or skip them first, or set the advanced override.`,
    );
  }

  if (!job.confirmations.leaveConfirmedTeamIds.includes(teamId)) {
    return deny(`Leaving "${team.displayName}" has not been confirmed yet.`);
  }

  return ALLOWED;
}

/* ---------------------------------------------------------- confirmations --- */

/**
 * Second-confirmation scopes this run needs before it may start.
 * Dry runs need none.
 */
export function requiredConfirmations(job: RunJob): ConfirmationScope[] {
  const required: ConfirmationScope[] = [];
  if (modeIsMutating(job.mode)) required.push('liveExecution');
  if (modeAllowsTrash(job.mode)) required.push('trash');
  if (modeAllowsLeave(job.mode)) required.push('leaveTeam');
  if (job.sourceTeams.length > 1) required.push('multiTeamBatch');

  const selectedCount = job.items.filter((item) => item.selected).length;
  if (selectedCount > job.settings.confirmationItemThreshold) required.push('largeBatch');

  return required;
}

export function missingConfirmations(job: RunJob): ConfirmationScope[] {
  const granted = new Set(job.confirmations.scopes);
  return requiredConfirmations(job).filter((scope) => !granted.has(scope));
}

/* ------------------------------------------------------------------ start --- */

export function canStartRun(job: RunJob): GuardResult {
  if (job.sourceTeams.length === 0) return deny('No source team selected.');
  if (job.items.filter((item) => item.selected).length === 0) {
    return deny('No items are included in this run.');
  }
  if (modeIsMutating(job.mode) && job.destination === null) {
    return deny('Pick a copy destination before starting.', 'destination_not_found');
  }
  if (modeIsMutating(job.mode) && job.destination?.kind === 'separateAccountShareCopy') {
    return deny('Separate-account share-and-copy mode is not available in this version.');
  }
  if (
    modeIsMutating(job.mode) &&
    job.destination?.kind === 'sameLoginWorkspace' &&
    job.sourceTeams.some((team) => team.internalId === job.destination?.teamId)
  ) {
    return deny('The destination cannot also be a source team in the same run.');
  }

  const missing = missingConfirmations(job);
  if (missing.length > 0) return deny(`Awaiting confirmation: ${missing.join(', ')}.`);

  return ALLOWED;
}

/* ------------------------------------------------------------- item queue --- */

/** True when the engine still has work to do on this item. */
export function itemNeedsWork(item: DesignItem): boolean {
  if (!item.selected) return false;
  if (isItemResolved(item)) return false;
  if (item.state === 'copyFailed' || item.state === 'deleteFailed' || item.state === 'manualReviewRequired') {
    // Failed items wait for an explicit retry or skip from the operator.
    return false;
  }
  return true;
}

export function nextItemNeedingWork(job: RunJob, teamId: string): DesignItem | undefined {
  return itemsForTeam(job, teamId).find((item) => itemNeedsWork(item));
}

/** Items that block the end-of-run "all clear" summary. */
export function blockingItems(job: RunJob): DesignItem[] {
  return job.items.filter(
    (item) =>
      item.selected &&
      (item.state === 'copyFailed' || item.state === 'deleteFailed' || item.state === 'manualReviewRequired'),
  );
}
