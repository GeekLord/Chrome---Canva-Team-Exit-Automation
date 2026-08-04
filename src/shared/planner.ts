/**
 * The planner: given a run job, what is the single next thing to do?
 *
 * Pure and total. The coordinator calls this in a loop, executes one action,
 * dispatches the resulting event, then calls it again. Because it is derived
 * from persisted state rather than an in-memory cursor, a resumed run picks up
 * exactly where it left off.
 */

import { isVerified } from './factories';
import {
  canLeaveTeam,
  itemNeedsWork,
  modeAllowsLeave,
  modeAllowsTrash,
  modeAllowsVerify,
  nextItemNeedingWork,
} from './guards';
import { isPreRun, isTerminal } from './run-state-machine';
import type { RunJob } from './types';

export type PlannedAction =
  | { kind: 'startTeam'; teamId: string }
  | { kind: 'copyItem'; itemId: string }
  | { kind: 'verifyItem'; itemId: string }
  | { kind: 'trashItem'; itemId: string }
  | { kind: 'teamItemsExhausted'; teamId: string }
  | { kind: 'awaitLeaveConfirmation'; teamId: string }
  | { kind: 'leaveTeam'; teamId: string }
  | { kind: 'completeTeam'; teamId: string }
  | { kind: 'finishRun' };

/** Actions that change something in Canva. Dry runs must never reach these. */
export const MUTATING_ACTION_KINDS: readonly PlannedAction['kind'][] = ['copyItem', 'trashItem', 'leaveTeam'];

export function isMutatingAction(kind: PlannedAction['kind']): boolean {
  return MUTATING_ACTION_KINDS.includes(kind);
}

export function planNextAction(job: RunJob): PlannedAction | null {
  // Dry runs finish at the review summary; there is no execution phase.
  if (job.mode === 'dryRun') return null;
  if (isTerminal(job.state) || isPreRun(job.state)) return null;
  if (job.state === 'paused' || job.state === 'blocked') return null;
  if (job.manualAssist) return null;

  if (!job.activeTeamId) {
    const nextTeamId = job.teamQueue[0];
    if (nextTeamId) return { kind: 'startTeam', teamId: nextTeamId };
    return { kind: 'finishRun' };
  }

  const teamId = job.activeTeamId;
  const item = nextItemNeedingWork(job, teamId);

  if (item) {
    if (item.copyStatus !== 'copied') return { kind: 'copyItem', itemId: item.internalId };
    if (modeAllowsVerify(job.mode) && !isVerified(item)) return { kind: 'verifyItem', itemId: item.internalId };
    if (modeAllowsTrash(job.mode) && item.deleteStatus !== 'trashed') {
      return { kind: 'trashItem', itemId: item.internalId };
    }
    // Copy done and nothing further applies in this mode: the reducer marks the
    // item complete on success, so reaching here means state is already settled.
  }

  const leaveOutstanding = modeAllowsLeave(job.mode) && !job.leftTeamIds.includes(teamId);

  if (leaveOutstanding) {
    if (job.state !== 'awaitingLeaveConfirmation') return { kind: 'teamItemsExhausted', teamId };
    return canLeaveTeam(job, teamId).allowed
      ? { kind: 'leaveTeam', teamId }
      : { kind: 'awaitLeaveConfirmation', teamId };
  }

  return { kind: 'completeTeam', teamId };
}

/** Operator-facing description of a planned action, for the popup status line. */
export function describePlannedAction(job: RunJob, action: PlannedAction): string {
  const teamName = (teamId: string): string =>
    job.sourceTeams.find((team) => team.internalId === teamId)?.displayName ?? teamId;
  const itemTitle = (itemId: string): string =>
    job.items.find((item) => item.internalId === itemId)?.title ?? itemId;

  switch (action.kind) {
    case 'startTeam':
      return `Switching to "${teamName(action.teamId)}"`;
    case 'copyItem':
      return `Copying "${itemTitle(action.itemId)}" to ${job.destination?.displayName ?? 'the destination'}`;
    case 'verifyItem':
      return `Verifying the copy of "${itemTitle(action.itemId)}"`;
    case 'trashItem':
      return `Moving the original of "${itemTitle(action.itemId)}" to trash`;
    case 'teamItemsExhausted':
      return `Finished items in "${teamName(action.teamId)}"`;
    case 'awaitLeaveConfirmation':
      return `Waiting for your confirmation to leave "${teamName(action.teamId)}"`;
    case 'leaveTeam':
      return `Leaving "${teamName(action.teamId)}"`;
    case 'completeTeam':
      return `Wrapping up "${teamName(action.teamId)}"`;
    case 'finishRun':
      return 'Finishing the run';
    default: {
      const exhaustive: never = action;
      return String(exhaustive);
    }
  }
}

/** Count of items still queued for automated work, for progress display. */
export function remainingWorkCount(job: RunJob): number {
  return job.items.filter((item) => itemNeedsWork(item)).length;
}
