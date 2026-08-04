import { describe, expect, it } from 'vitest';

import { makeItem, makeJob, makeReadyJob, makeTeam } from '../testing/fixtures';
import {
  blockingItems,
  canLeaveTeam,
  canStartRun,
  canTrashItem,
  itemNeedsWork,
  missingConfirmations,
  modeAllowsLeave,
  modeAllowsTrash,
  modeAllowsVerify,
  requiredConfirmations,
  unresolvedItemsForTeam,
} from './guards';

describe('mode capabilities', () => {
  it('maps each mode to the steps it is allowed to take', () => {
    expect(modeAllowsVerify('copyOnly')).toBe(false);
    expect(modeAllowsVerify('copyVerify')).toBe(true);
    expect(modeAllowsTrash('copyVerify')).toBe(false);
    expect(modeAllowsTrash('copyVerifyTrash')).toBe(true);
    expect(modeAllowsLeave('copyVerifyTrash')).toBe(false);
    expect(modeAllowsLeave('copyVerifyTrashLeave')).toBe(true);
  });
});

describe('canTrashItem', () => {
  const trashJob = makeJob({ mode: 'copyVerifyTrash' });

  it('says no when the mode does not include trashing', () => {
    const job = makeJob({ mode: 'copyVerify' });
    const result = canTrashItem(job, makeItem({ copyStatus: 'copied', verificationStatus: 'strong' }));
    expect(result.allowed).toBe(false);
  });

  it('says no when the copy has not completed', () => {
    const result = canTrashItem(trashJob, makeItem({ copyStatus: 'pending' }));
    expect(result).toMatchObject({ allowed: false, category: 'copy_verification_failed' });
  });

  it('says no when the copy is unverified', () => {
    const result = canTrashItem(trashJob, makeItem({ copyStatus: 'copied', verificationStatus: 'unverified' }));
    expect(result.allowed).toBe(false);
  });

  it('accepts weak and manual verification', () => {
    for (const level of ['strong', 'weak', 'manual'] as const) {
      const result = canTrashItem(trashJob, makeItem({ copyStatus: 'copied', verificationStatus: level }));
      expect(result.allowed, level).toBe(true);
    }
  });

  it('honours the explicit override for unverified copies', () => {
    const job = makeJob({
      mode: 'copyVerifyTrash',
      userOverrides: { allowTrashWithoutVerification: true, allowLeaveWithUnresolvedItems: false },
    });
    const result = canTrashItem(job, makeItem({ copyStatus: 'copied', verificationStatus: 'unverified' }));
    expect(result.allowed).toBe(true);
  });
});

describe('canLeaveTeam', () => {
  function leaveJob(overrides: Parameters<typeof makeJob>[0] = {}) {
    return makeJob({
      mode: 'copyVerifyTrashLeave',
      sourceTeams: [makeTeam()],
      confirmations: { scopes: [], leaveConfirmedTeamIds: ['team_source'] },
      items: [makeItem({ internalId: 'i1', state: 'completed', copyStatus: 'copied', verificationStatus: 'strong' })],
      ...overrides,
    });
  }

  it('allows leaving once every selected item is resolved and the team is confirmed', () => {
    expect(canLeaveTeam(leaveJob(), 'team_source').allowed).toBe(true);
  });

  it('blocks leaving when an item is unresolved', () => {
    const job = leaveJob({ items: [makeItem({ internalId: 'i1', state: 'copyFailed' })] });
    expect(unresolvedItemsForTeam(job, 'team_source')).toHaveLength(1);
    expect(canLeaveTeam(job, 'team_source').allowed).toBe(false);
  });

  it('ignores excluded items when deciding whether the team is clear', () => {
    const job = leaveJob({
      items: [makeItem({ internalId: 'i1', state: 'discovered', selected: false })],
    });
    expect(canLeaveTeam(job, 'team_source').allowed).toBe(true);
  });

  it('blocks leaving when Canva policy already said no', () => {
    const job = leaveJob({ sourceTeams: [makeTeam({ leaveSupportedState: 'blockedByPolicy' })] });
    expect(canLeaveTeam(job, 'team_source')).toMatchObject({
      allowed: false,
      category: 'leave_blocked_by_policy',
    });
  });

  it('blocks leaving without the per-team confirmation', () => {
    const job = leaveJob({ confirmations: { scopes: [], leaveConfirmedTeamIds: [] } });
    expect(canLeaveTeam(job, 'team_source').allowed).toBe(false);
  });
});

describe('confirmations', () => {
  it('asks for nothing in a dry run', () => {
    expect(requiredConfirmations(makeReadyJob({ mode: 'dryRun', grantConfirmations: false }))).toEqual([]);
  });

  it('asks for live, trash and leave confirmations in the full exit mode', () => {
    const job = makeReadyJob({ mode: 'copyVerifyTrashLeave', grantConfirmations: false });
    expect(requiredConfirmations(job)).toEqual(['liveExecution', 'trash', 'leaveTeam']);
  });

  it('asks for a multi-team confirmation when more than one team is queued', () => {
    const job = makeReadyJob({
      mode: 'copyOnly',
      grantConfirmations: false,
      teams: [makeTeam(), makeTeam({ internalId: 'team_two', displayName: 'Second team' })],
    });
    expect(requiredConfirmations(job)).toContain('multiTeamBatch');
  });

  it('asks for a large-batch confirmation above the threshold', () => {
    const job = makeReadyJob({ mode: 'copyOnly', itemCount: 30, grantConfirmations: false });
    expect(requiredConfirmations(job)).toContain('largeBatch');
    expect(missingConfirmations(job)).toContain('largeBatch');
  });
});

describe('canStartRun', () => {
  it('accepts a fully prepared run', () => {
    expect(canStartRun(makeReadyJob({ mode: 'copyVerifyTrash' })).allowed).toBe(true);
  });

  it('refuses when no destination is set for a live mode', () => {
    const job = makeReadyJob({ mode: 'copyOnly' });
    expect(canStartRun({ ...job, destination: null })).toMatchObject({
      allowed: false,
      category: 'destination_not_found',
    });
  });

  it('refuses when the destination is also a source team', () => {
    const job = makeReadyJob({ mode: 'copyOnly' });
    const clash = { ...job, destination: { ...job.destination!, teamId: 'team_source' } };
    expect(canStartRun(clash).allowed).toBe(false);
  });

  it('refuses when nothing is included', () => {
    const job = makeReadyJob({ mode: 'copyOnly' });
    const empty = { ...job, items: job.items.map((item) => ({ ...item, selected: false })) };
    expect(canStartRun(empty).allowed).toBe(false);
  });

  it('refuses the deferred separate-account destination mode', () => {
    const job = makeReadyJob({ mode: 'copyOnly' });
    const deferred = {
      ...job,
      destination: { kind: 'separateAccountShareCopy' as const, teamId: null, displayName: 'Other account', workspaceUrl: null },
    };
    expect(canStartRun(deferred).allowed).toBe(false);
  });
});

describe('work queue helpers', () => {
  it('excludes resolved, excluded and failed items from the work queue', () => {
    expect(itemNeedsWork(makeItem({ state: 'discovered' }))).toBe(true);
    expect(itemNeedsWork(makeItem({ state: 'completed' }))).toBe(false);
    expect(itemNeedsWork(makeItem({ state: 'skipped' }))).toBe(false);
    expect(itemNeedsWork(makeItem({ state: 'copyFailed' }))).toBe(false);
    expect(itemNeedsWork(makeItem({ state: 'manualReviewRequired' }))).toBe(false);
    expect(itemNeedsWork(makeItem({ selected: false }))).toBe(false);
  });

  it('reports failed and review items as blocking', () => {
    const job = makeJob({
      items: [
        makeItem({ internalId: 'a', state: 'completed' }),
        makeItem({ internalId: 'b', state: 'deleteFailed' }),
        makeItem({ internalId: 'c', state: 'manualReviewRequired' }),
      ],
    });
    expect(blockingItems(job).map((item) => item.internalId)).toEqual(['b', 'c']);
  });
});
