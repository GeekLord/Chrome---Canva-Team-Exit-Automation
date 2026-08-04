import { describe, expect, it } from 'vitest';

import { apply, makeReadyJob, makeTeam } from '../testing/fixtures';
import { planNextAction, isMutatingAction, remainingWorkCount } from './planner';
import type { RunJob } from './types';

const ITEM = 'team_source_item_1';

function started(mode: 'copyVerifyTrash' | 'copyVerifyTrashLeave' | 'copyOnly'): RunJob {
  return apply(makeReadyJob({ mode, itemCount: 1 }), [{ type: 'START_REQUESTED' }]);
}

describe('planNextAction', () => {
  it('plans nothing for a dry run', () => {
    expect(planNextAction(makeReadyJob({ mode: 'dryRun' }))).toBeNull();
  });

  it('plans nothing before the run starts', () => {
    expect(planNextAction(makeReadyJob({ mode: 'copyVerifyTrash' }))).toBeNull();
  });

  it('starts by switching into the first queued team', () => {
    expect(planNextAction(started('copyVerifyTrash'))).toEqual({ kind: 'startTeam', teamId: 'team_source' });
  });

  it('walks copy, then verify, then trash for the active item', () => {
    let job = apply(started('copyVerifyTrash'), [{ type: 'TEAM_STARTED', teamId: 'team_source' }]);
    expect(planNextAction(job)).toEqual({ kind: 'copyItem', itemId: ITEM });

    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM },
      { type: 'COPY_SUCCEEDED', itemId: ITEM },
    ]);
    expect(planNextAction(job)).toEqual({ kind: 'verifyItem', itemId: ITEM });

    job = apply(job, [
      { type: 'VERIFY_STARTED', itemId: ITEM },
      { type: 'VERIFY_SUCCEEDED', itemId: ITEM, level: 'weak' },
    ]);
    expect(planNextAction(job)).toEqual({ kind: 'trashItem', itemId: ITEM });

    job = apply(job, [
      { type: 'TRASH_STARTED', itemId: ITEM },
      { type: 'TRASH_SUCCEEDED', itemId: ITEM },
    ]);
    expect(planNextAction(job)).toEqual({ kind: 'completeTeam', teamId: 'team_source' });
  });

  it('skips the verify step in copy-only mode', () => {
    let job = apply(started('copyOnly'), [{ type: 'TEAM_STARTED', teamId: 'team_source' }]);
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM },
      { type: 'COPY_SUCCEEDED', itemId: ITEM },
    ]);
    expect(planNextAction(job)).toEqual({ kind: 'completeTeam', teamId: 'team_source' });
  });

  it('moves to the leave flow only after the item queue is clear', () => {
    let job = apply(started('copyVerifyTrashLeave'), [{ type: 'TEAM_STARTED', teamId: 'team_source' }]);
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM },
      { type: 'COPY_SUCCEEDED', itemId: ITEM },
      { type: 'VERIFY_STARTED', itemId: ITEM },
      { type: 'VERIFY_SUCCEEDED', itemId: ITEM, level: 'strong' },
      { type: 'TRASH_STARTED', itemId: ITEM },
      { type: 'TRASH_SUCCEEDED', itemId: ITEM },
    ]);
    expect(planNextAction(job)).toEqual({ kind: 'teamItemsExhausted', teamId: 'team_source' });

    job = apply(job, [{ type: 'TEAM_ITEMS_EXHAUSTED', teamId: 'team_source' }]);
    expect(planNextAction(job)).toEqual({ kind: 'awaitLeaveConfirmation', teamId: 'team_source' });

    job = apply(job, [{ type: 'LEAVE_CONFIRMED', teamId: 'team_source' }]);
    expect(planNextAction(job)).toEqual({ kind: 'leaveTeam', teamId: 'team_source' });
  });

  it('waits instead of retrying when a leave attempt failed', () => {
    let job = apply(started('copyVerifyTrashLeave'), [{ type: 'TEAM_STARTED', teamId: 'team_source' }]);
    job = apply(job, [
      { type: 'ITEM_SKIPPED', itemId: ITEM, reason: 'not needed' },
      { type: 'TEAM_ITEMS_EXHAUSTED', teamId: 'team_source' },
      { type: 'LEAVE_CONFIRMED', teamId: 'team_source' },
      { type: 'LEAVE_STARTED', teamId: 'team_source' },
      {
        type: 'LEAVE_FAILED',
        teamId: 'team_source',
        error: {
          category: 'leave_blocked_by_policy',
          message: 'blocked',
          detail: null,
          explanation: 'x',
          nextStep: 'y',
          resolution: 'block',
          escalation: 'block',
          retryable: false,
        },
      },
    ]);
    expect(planNextAction(job)).toEqual({ kind: 'awaitLeaveConfirmation', teamId: 'team_source' });
  });

  it('plans the next team, then finishes the run', () => {
    const twoTeams = makeReadyJob({
      mode: 'copyOnly',
      itemCount: 1,
      teams: [makeTeam(), makeTeam({ internalId: 'team_two', displayName: 'Second team' })],
    });
    let job = apply(twoTeams, [{ type: 'START_REQUESTED' }, { type: 'TEAM_STARTED', teamId: 'team_source' }]);
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM },
      { type: 'COPY_SUCCEEDED', itemId: ITEM },
      { type: 'TEAM_COMPLETED', teamId: 'team_source' },
    ]);
    expect(planNextAction(job)).toEqual({ kind: 'startTeam', teamId: 'team_two' });

    job = apply(job, [
      { type: 'TEAM_STARTED', teamId: 'team_two' },
      { type: 'COPY_STARTED', itemId: 'team_two_item_1' },
      { type: 'COPY_SUCCEEDED', itemId: 'team_two_item_1' },
      { type: 'TEAM_COMPLETED', teamId: 'team_two' },
    ]);
    expect(planNextAction(job)).toEqual({ kind: 'finishRun' });
  });

  it('plans nothing while paused, blocked or awaiting a manual step', () => {
    const job = apply(started('copyVerifyTrash'), [{ type: 'TEAM_STARTED', teamId: 'team_source' }]);
    expect(planNextAction(apply(job, [{ type: 'PAUSE_REQUESTED' }]))).toBeNull();
    expect(
      planNextAction(
        apply(job, [
          { type: 'MANUAL_ASSIST_REQUESTED', itemId: ITEM, step: 'copy', instruction: 'do it' },
        ]),
      ),
    ).toBeNull();
  });

  it('knows which planned actions change Canva content', () => {
    expect(isMutatingAction('copyItem')).toBe(true);
    expect(isMutatingAction('trashItem')).toBe(true);
    expect(isMutatingAction('leaveTeam')).toBe(true);
    expect(isMutatingAction('startTeam')).toBe(false);
    expect(isMutatingAction('verifyItem')).toBe(false);
  });

  it('counts remaining work', () => {
    const job = apply(started('copyVerifyTrash'), [{ type: 'TEAM_STARTED', teamId: 'team_source' }]);
    expect(remainingWorkCount(job)).toBe(1);
    expect(remainingWorkCount(apply(job, [{ type: 'ITEM_SKIPPED', itemId: ITEM, reason: 'x' }]))).toBe(0);
  });
});
