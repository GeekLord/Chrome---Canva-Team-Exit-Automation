import { describe, expect, it } from 'vitest';

import {
  apply,
  applyWithLogs,
  ctx,
  makeItem,
  makeJob,
  makeReadyJob,
  makeTeam,
  NOW,
} from '../testing/fixtures';
import { normalizeError } from './errors';
import { findItem } from './factories';
import { reduceRun } from './run-state-machine';

const ITEM_ID = 'team_source_item_1';

function startedJob(mode: Parameters<typeof makeReadyJob>[0] extends undefined ? never : 'copyVerifyTrash' | 'copyVerifyTrashLeave' | 'copyVerify' | 'copyOnly') {
  const ready = makeReadyJob({ mode });
  return apply(ready, [{ type: 'START_REQUESTED' }, { type: 'TEAM_STARTED', teamId: 'team_source' }]);
}

describe('run state machine: the copy → verify → trash order', () => {
  it('walks an item from queued to completed and keeps counters in step', () => {
    let job = startedJob('copyVerifyTrash');

    job = apply(job, [{ type: 'COPY_STARTED', itemId: ITEM_ID }]);
    expect(findItem(job, ITEM_ID)?.state).toBe('copyInProgress');
    expect(findItem(job, ITEM_ID)?.attempts.copy).toBe(1);

    job = apply(job, [{ type: 'COPY_SUCCEEDED', itemId: ITEM_ID, sawConfirmation: true }]);
    expect(findItem(job, ITEM_ID)?.state).toBe('copied');
    expect(findItem(job, ITEM_ID)?.copyStatus).toBe('copied');
    expect(findItem(job, ITEM_ID)?.copyConfirmationSeen).toBe(true);
    expect(job.counters.copied).toBe(1);

    job = apply(job, [
      { type: 'VERIFY_STARTED', itemId: ITEM_ID },
      { type: 'VERIFY_SUCCEEDED', itemId: ITEM_ID, level: 'strong' },
    ]);
    expect(findItem(job, ITEM_ID)?.state).toBe('copyVerified');
    expect(job.counters.verified).toBe(1);

    job = apply(job, [
      { type: 'TRASH_STARTED', itemId: ITEM_ID },
      { type: 'TRASH_SUCCEEDED', itemId: ITEM_ID },
    ]);
    expect(findItem(job, ITEM_ID)?.state).toBe('completed');
    expect(findItem(job, ITEM_ID)?.deleteStatus).toBe('trashed');
    expect(job.counters.trashed).toBe(1);
  });

  it('completes the item at copy time when the mode has no verify step', () => {
    let job = startedJob('copyOnly');
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM_ID },
      { type: 'COPY_SUCCEEDED', itemId: ITEM_ID },
    ]);
    expect(findItem(job, ITEM_ID)?.state).toBe('completed');
  });

  it('refuses to trash an item whose copy was never verified', () => {
    let job = startedJob('copyVerifyTrash');
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM_ID },
      { type: 'COPY_SUCCEEDED', itemId: ITEM_ID },
    ]);

    const result = applyWithLogs(job, [{ type: 'TRASH_STARTED', itemId: ITEM_ID }]);
    const item = findItem(result.job, ITEM_ID);

    expect(item?.deleteStatus).toBe('blocked');
    expect(item?.state).toBe('manualReviewRequired');
    expect(result.logs.some((entry) => entry.resultStatus === 'blocked')).toBe(true);
    expect(result.job.counters.trashed).toBe(0);
  });

  it('refuses to trash an item that was never copied', () => {
    const job = startedJob('copyVerifyTrash');
    const result = applyWithLogs(job, [{ type: 'TRASH_STARTED', itemId: ITEM_ID }]);
    expect(findItem(result.job, ITEM_ID)?.deleteStatus).toBe('blocked');
    expect(result.logs[0]?.errorCategory).toBe('copy_verification_failed');
  });

  it('allows trashing an unverified copy only with the explicit override', () => {
    let job = startedJob('copyVerifyTrash');
    job = {
      ...job,
      userOverrides: { ...job.userOverrides, allowTrashWithoutVerification: true },
    };
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM_ID },
      { type: 'COPY_SUCCEEDED', itemId: ITEM_ID },
      { type: 'TRASH_STARTED', itemId: ITEM_ID },
    ]);
    expect(findItem(job, ITEM_ID)?.state).toBe('deleteInProgress');
  });

  it('parks the item for review when verification fails, leaving the original alone', () => {
    let job = startedJob('copyVerifyTrash');
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM_ID },
      { type: 'COPY_SUCCEEDED', itemId: ITEM_ID },
      { type: 'VERIFY_STARTED', itemId: ITEM_ID },
      { type: 'VERIFY_FAILED', itemId: ITEM_ID, error: normalizeError({ category: 'copy_verification_failed' }) },
    ]);

    const item = findItem(job, ITEM_ID);
    expect(item?.state).toBe('manualReviewRequired');
    expect(item?.verificationStatus).toBe('failed');
    expect(item?.deleteStatus).toBe('notRequested');
  });
});

describe('run state machine: guards on starting', () => {
  it('rejects a start with missing confirmations and leaves the state untouched', () => {
    const job = makeReadyJob({ grantConfirmations: false });
    const result = applyWithLogs(job, [{ type: 'START_REQUESTED' }]);

    expect(result.job.state).toBe('reviewReady');
    expect(result.job.startedAt).toBeNull();
    expect(result.logs[0]?.action).toBe('reject:START_REQUESTED');
    expect(result.logs[0]?.level).toBe('warn');
  });

  it('rejects a start in dry-run mode because there is no execution phase', () => {
    const job = makeReadyJob({ mode: 'dryRun' });
    const result = applyWithLogs(job, [{ type: 'START_REQUESTED' }]);
    expect(result.job.state).toBe('reviewReady');
    expect(result.logs[0]?.message).toContain('dry run has no execution phase');
  });

  it('never copies in dry-run mode', () => {
    const job = makeReadyJob({ mode: 'dryRun' });
    const result = applyWithLogs(job, [{ type: 'COPY_STARTED', itemId: ITEM_ID }]);
    expect(findItem(result.job, ITEM_ID)?.copyStatus).toBe('pending');
    expect(result.logs[0]?.message).toContain('dry run never copies');
  });

  it('resets confirmations when the mode changes', () => {
    const job = makeReadyJob({ mode: 'copyVerifyTrash' });
    expect(job.confirmations.scopes.length).toBeGreaterThan(0);
    const changed = apply(job, [{ type: 'MODE_SELECTED', mode: 'copyOnly' }]);
    expect(changed.confirmations.scopes).toEqual([]);
  });
});

describe('run state machine: leaving a team', () => {
  function jobReadyToLeave() {
    let job = makeReadyJob({ mode: 'copyVerifyTrashLeave', itemCount: 1 });
    job = apply(job, [{ type: 'START_REQUESTED' }, { type: 'TEAM_STARTED', teamId: 'team_source' }]);
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM_ID },
      { type: 'COPY_SUCCEEDED', itemId: ITEM_ID, sawConfirmation: true },
      { type: 'VERIFY_STARTED', itemId: ITEM_ID },
      { type: 'VERIFY_SUCCEEDED', itemId: ITEM_ID, level: 'strong' },
      { type: 'TRASH_STARTED', itemId: ITEM_ID },
      { type: 'TRASH_SUCCEEDED', itemId: ITEM_ID },
      { type: 'TEAM_ITEMS_EXHAUSTED', teamId: 'team_source' },
    ]);
    return job;
  }

  it('waits for a per-team confirmation before leaving', () => {
    const job = jobReadyToLeave();
    expect(job.state).toBe('awaitingLeaveConfirmation');

    const blocked = applyWithLogs(job, [{ type: 'LEAVE_STARTED', teamId: 'team_source' }]);
    expect(blocked.job.state).toBe('awaitingLeaveConfirmation');
    expect(blocked.logs[0]?.message).toContain('has not been confirmed');

    const confirmed = apply(job, [
      { type: 'LEAVE_CONFIRMED', teamId: 'team_source' },
      { type: 'LEAVE_STARTED', teamId: 'team_source' },
    ]);
    expect(confirmed.state).toBe('leavingTeam');
  });

  it('blocks leaving while a selected item is unresolved', () => {
    let job = makeReadyJob({ mode: 'copyVerifyTrashLeave', itemCount: 2 });
    job = apply(job, [{ type: 'START_REQUESTED' }, { type: 'TEAM_STARTED', teamId: 'team_source' }]);
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM_ID },
      { type: 'COPY_FAILED', itemId: ITEM_ID, error: normalizeError({ category: 'selector_not_found' }) },
      { type: 'LEAVE_CONFIRMED', teamId: 'team_source' },
    ]);

    const result = applyWithLogs(job, [{ type: 'LEAVE_STARTED', teamId: 'team_source' }]);
    expect(result.job.state).not.toBe('leavingTeam');
    expect(result.logs[0]?.message).toContain('unresolved');
  });

  it('withdraws the confirmation after a failed leave so the engine cannot loop', () => {
    const job = apply(jobReadyToLeave(), [
      { type: 'LEAVE_CONFIRMED', teamId: 'team_source' },
      { type: 'LEAVE_STARTED', teamId: 'team_source' },
      {
        type: 'LEAVE_FAILED',
        teamId: 'team_source',
        error: normalizeError({ category: 'leave_blocked_by_policy' }),
      },
    ]);

    expect(job.confirmations.leaveConfirmedTeamIds).toEqual([]);
    expect(job.state).toBe('awaitingLeaveConfirmation');
    expect(job.sourceTeams[0]?.leaveSupportedState).toBe('blockedByPolicy');
    expect(job.leftTeamIds).toEqual([]);
  });

  it('records a successful leave once', () => {
    const job = apply(jobReadyToLeave(), [
      { type: 'LEAVE_CONFIRMED', teamId: 'team_source' },
      { type: 'LEAVE_STARTED', teamId: 'team_source' },
      { type: 'LEAVE_SUCCEEDED', teamId: 'team_source' },
      { type: 'LEAVE_SUCCEEDED', teamId: 'team_source' },
    ]);
    expect(job.leftTeamIds).toEqual(['team_source']);
    expect(job.counters.teamsLeft).toBe(1);
  });
});

describe('run state machine: interruption and recovery', () => {
  it('requeues an interrupted copy and parks an interrupted trash', () => {
    const job = makeJob({
      state: 'copying',
      sourceTeams: [makeTeam()],
      items: [
        makeItem({ internalId: 'item_copying', state: 'copyInProgress', copyStatus: 'inProgress' }),
        makeItem({
          internalId: 'item_trashing',
          state: 'deleteInProgress',
          copyStatus: 'copied',
          verificationStatus: 'strong',
          deleteStatus: 'inProgress',
        }),
      ],
    });

    const recovered = apply(job, [{ type: 'RUN_RECOVERED', reason: 'worker restart' }]);

    expect(findItem(recovered, 'item_copying')?.state).toBe('copyPending');
    expect(findItem(recovered, 'item_copying')?.copyStatus).toBe('pending');
    expect(findItem(recovered, 'item_trashing')?.state).toBe('manualReviewRequired');
    expect(findItem(recovered, 'item_trashing')?.deleteStatus).toBe('blocked');
    expect(recovered.state).toBe('paused');
  });

  it('pauses and resumes back into an executing state', () => {
    let job = startedJob('copyVerifyTrash');
    job = apply(job, [{ type: 'PAUSE_REQUESTED', reason: 'operator' }]);
    expect(job.state).toBe('paused');
    expect(job.pauseReason).toBe('operator');

    job = apply(job, [{ type: 'RESUME_REQUESTED' }]);
    expect(job.state).toBe('copying');
    expect(job.pauseReason).toBeNull();
  });

  it('refuses to resume while a manual step is pending', () => {
    let job = startedJob('copyVerifyTrash');
    job = apply(job, [
      {
        type: 'MANUAL_ASSIST_REQUESTED',
        itemId: ITEM_ID,
        step: 'copy',
        instruction: 'Copy it yourself',
      },
    ]);
    const result = applyWithLogs(job, [{ type: 'RESUME_REQUESTED' }]);
    expect(result.job.state).toBe('paused');
    expect(result.logs[0]?.message).toContain('resolve the pending manual step');
  });

  it('treats a confirmed manual copy as manual verification', () => {
    let job = startedJob('copyVerifyTrash');
    job = apply(job, [
      { type: 'MANUAL_ASSIST_REQUESTED', itemId: ITEM_ID, step: 'copy', instruction: 'Copy it yourself' },
      { type: 'MANUAL_ASSIST_RESOLVED', itemId: ITEM_ID, outcome: 'done' },
    ]);

    const item = findItem(job, ITEM_ID);
    expect(item?.copyStatus).toBe('copied');
    expect(item?.verificationStatus).toBe('manual');
    expect(item?.state).toBe('copyVerified');
    expect(job.manualAssist).toBeNull();
  });
});

describe('run state machine: bookkeeping', () => {
  it('finishes with warnings when something is still blocking', () => {
    let job = startedJob('copyVerifyTrash');
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM_ID },
      { type: 'COPY_FAILED', itemId: ITEM_ID, error: normalizeError({ category: 'copy_action_missing' }) },
      { type: 'RUN_FINISHED' },
    ]);
    expect(job.state).toBe('completedWithWarnings');
    expect(job.endedAt).toBe(NOW);
  });

  it('finishes cleanly when every item resolved', () => {
    let job = startedJob('copyOnly');
    for (const item of job.items) {
      job = apply(job, [
        { type: 'COPY_STARTED', itemId: item.internalId },
        { type: 'COPY_SUCCEEDED', itemId: item.internalId },
      ]);
    }
    job = apply(job, [{ type: 'RUN_FINISHED' }]);
    expect(job.state).toBe('completed');
  });

  it('ignores unknown item ids without changing state', () => {
    const job = startedJob('copyVerifyTrash');
    const result = reduceRun(job, { type: 'COPY_STARTED', itemId: 'nope' }, ctx());
    expect(result.job).toBe(job);
    expect(result.logs[0]?.message).toContain('unknown item');
  });

  it('reopens a finished run when an item is retried afterwards', () => {
    let job = startedJob('copyVerifyTrash');
    job = apply(job, [
      { type: 'TEAM_STARTED', teamId: 'team_source' },
      { type: 'COPY_STARTED', itemId: ITEM_ID },
      { type: 'COPY_FAILED', itemId: ITEM_ID, error: normalizeError({ category: 'selector_not_found' }) },
      { type: 'TEAM_COMPLETED', teamId: 'team_source' },
      { type: 'RUN_FINISHED' },
    ]);
    expect(job.state).toBe('completedWithWarnings');
    expect(job.processedTeamIds).toEqual(['team_source']);

    job = apply(job, [{ type: 'ITEM_RETRY_REQUESTED', itemId: ITEM_ID }]);

    expect(job.state).toBe('copying');
    expect(job.endedAt).toBeNull();
    expect(job.activeTeamId).toBe('team_source');
    expect(job.processedTeamIds).toEqual([]);
    expect(findItem(job, ITEM_ID)?.state).toBe('copyPending');
  });

  it('keeps a failed item out of the work queue until it is retried', () => {
    let job = startedJob('copyVerifyTrash');
    job = apply(job, [
      { type: 'COPY_STARTED', itemId: ITEM_ID },
      { type: 'COPY_FAILED', itemId: ITEM_ID, error: normalizeError({ category: 'selector_not_found' }) },
    ]);
    expect(job.counters.failed).toBe(1);

    job = apply(job, [{ type: 'ITEM_RETRY_REQUESTED', itemId: ITEM_ID }]);
    expect(findItem(job, ITEM_ID)?.state).toBe('copyPending');
    expect(findItem(job, ITEM_ID)?.lastError).toBeNull();
    expect(job.counters.failed).toBe(0);
  });
});
