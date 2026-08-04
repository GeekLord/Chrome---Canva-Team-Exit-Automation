/**
 * Integration tests for the engine: content/background messaging, dry-run
 * generation, the copy → verify → trash order, persistence and resume.
 *
 * These drive the real coordinator, tab controller, reducer, guards, log store
 * and storage layer against a fake Canva tab.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LogStore } from '../logging/log-store';
import type { BroadcastMessage } from '../shared/messages';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { STORAGE_KEYS } from '../shared/storage-keys';
import type { Settings, Team } from '../shared/types';
import {
  fakeItems,
  installFakeChrome,
  makeFakeCanva,
  type FakeCanva,
  type FakeCanvaOptions,
  immediateWait,
  type InstalledFakeChrome,
} from '../testing/harness';
import { RunCoordinator } from './run-coordinator';
import { ExtensionStore } from './storage';
import { TabController } from './tab-controller';

const NOW = '2026-08-04T10:00:00.000Z';

const SOURCE: Team = {
  internalId: 'team_source',
  displayName: 'Design Studio',
  workspaceUrl: 'https://www.canva.com/folder/all-projects?brand=SOURCE',
  leaveSupportedState: 'unknown',
  discoveryTimestamp: NOW,
  isCurrent: true,
  isPersonal: false,
};

const DESTINATION: Team = {
  internalId: 'team_personal',
  displayName: 'Personal',
  workspaceUrl: 'https://www.canva.com/folder/all-projects?brand=PERSONAL',
  leaveSupportedState: 'notApplicable',
  discoveryTimestamp: NOW,
  isCurrent: false,
  isPersonal: true,
};

const LIVE_SETTINGS: Partial<Settings> = {
  liveExecutionEnabled: true,
  disclosureAcceptedAt: NOW,
  probeItemLimitPerTeam: 5,
  pauseBetweenTeams: false,
  manualAssistEnabled: false,
  maxRetriesPerAction: 1,
};

interface Rig {
  chrome: InstalledFakeChrome;
  canva: FakeCanva;
  coordinator: RunCoordinator;
  broadcasts: BroadcastMessage[];
  storage: Map<string, unknown>;
  /** Rebuilds the coordinator over the same storage, as a worker restart would. */
  restart(): Promise<RunCoordinator>;
}

let active: InstalledFakeChrome | null = null;

async function buildRig(
  canvaOptions: Partial<FakeCanvaOptions> = {},
  settings: Partial<Settings> = LIVE_SETTINGS,
): Promise<Rig> {
  const titles = ['Quarterly report', 'Team poster'];
  const options: FakeCanvaOptions = {
    teams: [SOURCE, DESTINATION],
    itemsByTeam: { team_source: fakeItems('team_source', titles, NOW) },
    ...canvaOptions,
  };

  let canva: FakeCanva;
  const chrome = installFakeChrome({
    initialUrl: SOURCE.workspaceUrl ?? undefined,
    onMessage: (tabId, request) => canva.handle(tabId, request),
  });
  active = chrome;
  canva = makeFakeCanva(options, chrome.tabs);

  const broadcasts: BroadcastMessage[] = [];
  const publish = (message: BroadcastMessage): void => {
    broadcasts.push(message);
  };
  const noWait = immediateWait;

  const store = new ExtensionStore(storageAdapter());
  await store.saveSettings({ ...DEFAULT_SETTINGS, ...settings });

  const build = async (): Promise<RunCoordinator> => {
    const logs = new LogStore(storageAdapter(), { maxEventsPerRun: 500 });
    const coordinator = new RunCoordinator(new ExtensionStore(storageAdapter()), logs, new TabController(noWait), publish, {
      wait: noWait,
    });
    await coordinator.init();
    return coordinator;
  };

  const coordinator = await build();
  return { chrome, canva, coordinator, broadcasts, storage: chrome.storage, restart: build };
}

function storageAdapter() {
  return {
    async get(keys: string[]) {
      return (await chrome.storage.local.get(keys)) as Record<string, unknown>;
    },
    async set(entries: Record<string, unknown>) {
      await chrome.storage.local.set(entries);
    },
    async remove(keys: string[]) {
      await chrome.storage.local.remove(keys);
    },
  };
}

async function prepare(rig: Rig, mode: Settings['defaultMode']): Promise<void> {
  await rig.coordinator.scanTeams();
  await rig.coordinator.selectMode(mode);
  await rig.coordinator.selectTeams([SOURCE.internalId]);
  await rig.coordinator.selectDestination(DESTINATION.internalId);
  await rig.coordinator.scanItems();
}

async function grantEverything(rig: Rig): Promise<void> {
  const snapshot = await rig.coordinator.snapshot(false);
  for (const scope of snapshot.requiredConfirmations) {
    await rig.coordinator.grantConfirmation(scope);
  }
}

afterEach(() => {
  active?.restore();
  active = null;
});

describe('dry-run generation', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await buildRig();
  });

  it('discovers teams, items and copy capability without changing anything', async () => {
    await prepare(rig, 'dryRun');
    const snapshot = await rig.coordinator.snapshot(false);

    expect(snapshot.job.state).toBe('reviewReady');
    expect(snapshot.discoveredTeams).toHaveLength(2);
    expect(snapshot.job.items).toHaveLength(2);
    expect(snapshot.job.items.every((item) => item.copyCapability === 'available')).toBe(true);
    expect(snapshot.job.counters.itemsSelected).toBe(2);

    // The point of a dry run: no mutating request was ever sent.
    expect(rig.canva.countOf('COPY_ITEM')).toBe(0);
    expect(rig.canva.countOf('TRASH_ITEM')).toBe(0);
    expect(rig.canva.countOf('LEAVE_TEAM')).toBe(0);
    expect(rig.canva.countOf('PROBE_ITEM')).toBe(2);
  });

  it('refuses to start a dry run and finishes it with a saved report', async () => {
    await prepare(rig, 'dryRun');

    const start = await rig.coordinator.startRun();
    expect(start.ok).toBe(false);
    expect(start.message).toContain('dry run has no execution phase');

    await rig.coordinator.stopRun();
    const snapshot = await rig.coordinator.snapshot(false);
    expect(snapshot.job.state).toBe('completed');
    expect(rig.storage.get(STORAGE_KEYS.lastReport)).toBeDefined();
  });

  it('marks probes as unknown when the cap is zero', async () => {
    rig = await buildRig({}, { ...LIVE_SETTINGS, probeItemLimitPerTeam: 0 });
    await prepare(rig, 'dryRun');

    expect(rig.canva.countOf('PROBE_ITEM')).toBe(0);
    const snapshot = await rig.coordinator.snapshot(false);
    expect(snapshot.job.items.every((item) => item.copyCapability === 'unknown')).toBe(true);
    expect(snapshot.job.items.every((item) => item.riskFlags.includes('copyActionUnknown'))).toBe(true);
  });
});

describe('live run: copy, verify, trash', () => {
  it('processes every item in order and trashes only verified copies', async () => {
    const rig = await buildRig({ copyShowsConfirmation: true });
    await prepare(rig, 'copyVerifyTrash');
    await grantEverything(rig);

    const start = await rig.coordinator.startRun();
    expect(start.ok).toBe(true);
    await settle(rig);

    const snapshot = await rig.coordinator.snapshot(false);
    expect(snapshot.job.state).toBe('completed');
    expect(snapshot.job.counters.copied).toBe(2);
    expect(snapshot.job.counters.verified).toBe(2);
    expect(snapshot.job.counters.trashed).toBe(2);
    expect(rig.canva.copiedTitles).toEqual(['Quarterly report', 'Team poster']);
    expect(rig.canva.trashedTitles).toEqual(['Quarterly report', 'Team poster']);

    // Per item, the copy request always precedes the trash request.
    for (const title of ['Quarterly report', 'Team poster']) {
      const sequence = rig.canva.typesFor(title);
      expect(sequence.indexOf('COPY_ITEM')).toBeLessThan(sequence.indexOf('TRASH_ITEM'));
    }

    // An explicit Canva confirmation means no destination round trip is needed.
    expect(rig.canva.countOf('VERIFY_COPY')).toBe(0);
    expect(snapshot.job.items.every((item) => item.verificationStatus === 'strong')).toBe(true);
  });

  it('falls back to checking the destination listing when Canva showed no confirmation', async () => {
    const rig = await buildRig({ copyShowsConfirmation: false });
    await prepare(rig, 'copyVerifyTrash');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    const snapshot = await rig.coordinator.snapshot(false);
    expect(rig.canva.countOf('VERIFY_COPY')).toBe(2);
    expect(snapshot.job.items.every((item) => item.verificationStatus === 'weak')).toBe(true);
    expect(snapshot.job.counters.trashed).toBe(2);

    // Verification visits the destination workspace and comes back.
    expect(rig.chrome.navigations.some((url) => url.includes('PERSONAL'))).toBe(true);
    expect(rig.chrome.navigations.some((url) => url.includes('SOURCE'))).toBe(true);
  });

  it('never trashes an original when verification fails', async () => {
    const rig = await buildRig({
      copyShowsConfirmation: false,
      failures: { VERIFY_COPY: { category: 'copy_verification_failed' } },
    });
    await prepare(rig, 'copyVerifyTrash');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    const snapshot = await rig.coordinator.snapshot(false);
    expect(snapshot.job.counters.copied).toBe(2);
    expect(snapshot.job.counters.trashed).toBe(0);
    expect(rig.canva.countOf('TRASH_ITEM')).toBe(0);
    expect(snapshot.job.items.every((item) => item.state === 'manualReviewRequired')).toBe(true);
  });

  it('leaves the copy-only mode without touching originals', async () => {
    const rig = await buildRig({ copyShowsConfirmation: true });
    await prepare(rig, 'copyOnly');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    const snapshot = await rig.coordinator.snapshot(false);
    expect(snapshot.job.counters.copied).toBe(2);
    expect(snapshot.job.counters.trashed).toBe(0);
    expect(rig.canva.countOf('VERIFY_COPY')).toBe(0);
    expect(rig.canva.countOf('TRASH_ITEM')).toBe(0);
  });
});

describe('live run: failures', () => {
  it('retries a retryable failure up to the configured limit, then records it', async () => {
    const rig = await buildRig({
      copyShowsConfirmation: true,
      failures: { COPY_ITEM: { category: 'selector_not_found' } },
    });
    await prepare(rig, 'copyVerifyTrash');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    const snapshot = await rig.coordinator.snapshot(false);
    // maxRetriesPerAction is 1, so two attempts per item, two items.
    expect(rig.canva.countOf('COPY_ITEM')).toBe(4);
    expect(snapshot.job.counters.failed).toBe(2);
    expect(snapshot.job.counters.trashed).toBe(0);
    expect(snapshot.job.state).toBe('completedWithWarnings');
  });

  it('does not retry a failure that says retrying is pointless', async () => {
    const rig = await buildRig({ failures: { COPY_ITEM: { category: 'copy_action_missing' } } });
    await prepare(rig, 'copyVerifyTrash');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    expect(rig.canva.countOf('COPY_ITEM')).toBe(2);
  });

  it('halts the whole run when Canva asks for sign-in', async () => {
    const rig = await buildRig({ failures: { COPY_ITEM: { category: 'auth_required' } } });
    await prepare(rig, 'copyVerifyTrash');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    const snapshot = await rig.coordinator.snapshot(false);
    expect(snapshot.job.state).toBe('blocked');
    expect(snapshot.job.blocker?.category).toBe('auth_required');
    // One item attempted, then everything stops.
    expect(rig.canva.countOf('COPY_ITEM')).toBe(1);
    expect(rig.broadcasts.some((message) => message.type === 'RUN_ATTENTION')).toBe(true);
  });

  it('halts before acting when the page shows a captcha', async () => {
    const rig = await buildRig({ interruption: 'captcha' });
    const outcome = await rig.coordinator.scanTeams();

    expect(outcome.ok).toBe(false);
    expect(outcome.category).toBe('rate_limited_or_captcha');
    expect(rig.canva.countOf('DISCOVER_TEAMS')).toBe(0);
  });

  it('asks for a manual step instead of failing when manual assist is on', async () => {
    const rig = await buildRig(
      { failures: { COPY_ITEM: { category: 'copy_action_missing' } } },
      { ...LIVE_SETTINGS, manualAssistEnabled: true },
    );
    await prepare(rig, 'copyVerifyTrash');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    const snapshot = await rig.coordinator.snapshot(false);
    expect(snapshot.job.manualAssist).not.toBeNull();
    expect(snapshot.job.state).toBe('paused');
    expect(rig.canva.countOf('HIGHLIGHT_ITEM')).toBe(1);

    // Confirming by hand counts as a manual verification, and the run continues.
    const itemId = snapshot.job.manualAssist?.itemId ?? '';
    await rig.coordinator.resolveManualAssist(itemId, 'done');
    await settle(rig);

    const after = await rig.coordinator.snapshot(false);
    const item = after.job.items.find((candidate) => candidate.internalId === itemId);
    expect(item?.verificationStatus).toBe('manual');
    expect(rig.canva.trashedTitles).toContain(item?.title);
  });
});

describe('leaving the team', () => {
  it('waits for a per-team confirmation, then leaves', async () => {
    const rig = await buildRig({ copyShowsConfirmation: true });
    await prepare(rig, 'copyVerifyTrashLeave');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    let snapshot = await rig.coordinator.snapshot(false);
    expect(snapshot.job.state).toBe('awaitingLeaveConfirmation');
    expect(rig.canva.countOf('LEAVE_TEAM')).toBe(0);

    await rig.coordinator.confirmLeave(SOURCE.internalId);
    await settle(rig);

    snapshot = await rig.coordinator.snapshot(false);
    expect(rig.canva.leftTeams).toEqual([SOURCE.internalId]);
    expect(snapshot.job.counters.teamsLeft).toBe(1);
    expect(snapshot.job.state).toBe('completed');
  });

  it('reports an admin policy block without looping', async () => {
    const rig = await buildRig({ copyShowsConfirmation: true, leaveOutcome: 'blocked' });
    await prepare(rig, 'copyVerifyTrashLeave');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);
    await rig.coordinator.confirmLeave(SOURCE.internalId);
    await settle(rig);

    const snapshot = await rig.coordinator.snapshot(false);
    expect(snapshot.job.counters.teamsLeft).toBe(0);
    expect(snapshot.job.sourceTeams[0]?.leaveSupportedState).toBe('blockedByPolicy');
    expect(snapshot.job.confirmations.leaveConfirmedTeamIds).toEqual([]);
    // Two settings pages are tried at most, so this cannot spin.
    expect(rig.canva.countOf('LEAVE_TEAM')).toBeLessThanOrEqual(2);
  });

  it('lets the operator finish a team without leaving it', async () => {
    const rig = await buildRig({ copyShowsConfirmation: true });
    await prepare(rig, 'copyVerifyTrashLeave');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    await rig.coordinator.skipLeave(SOURCE.internalId);
    await settle(rig);

    const snapshot = await rig.coordinator.snapshot(false);
    expect(rig.canva.countOf('LEAVE_TEAM')).toBe(0);
    expect(snapshot.job.counters.teamsProcessed).toBe(1);
    expect(snapshot.job.state).toBe('completed');
  });
});

describe('persistence and resume', () => {
  it('keeps run state across a worker restart and resumes the remaining items', async () => {
    const rig = await buildRig({ copyShowsConfirmation: true });
    await prepare(rig, 'copyVerifyTrash');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    const before = await rig.coordinator.snapshot(false);
    expect(before.job.counters.trashed).toBe(2);

    // A fresh coordinator over the same storage, as after an eviction.
    const revived = await rig.restart();
    const after = await revived.snapshot(false);

    expect(after.job.runId).toBe(before.job.runId);
    expect(after.job.counters.trashed).toBe(2);
    expect(after.job.items.map((item) => item.state)).toEqual(before.job.items.map((item) => item.state));
  });

  it('halts on a sign-in wall mid-trash, then resumes the rest of the queue', async () => {
    const rig = await buildRig({
      copyShowsConfirmation: true,
      failures: { TRASH_ITEM: { category: 'auth_required', times: 1 } },
    });
    await prepare(rig, 'copyVerifyTrash');
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    const blocked = await rig.coordinator.snapshot(false);
    expect(blocked.job.state).toBe('blocked');
    expect(blocked.job.blocker?.category).toBe('auth_required');

    // The interrupted item is recorded as failed rather than left mid-step, so a
    // resume cannot silently retry a trash whose outcome nobody checked.
    const interrupted = blocked.job.items[0]!;
    expect(interrupted.state).toBe('deleteFailed');
    expect(interrupted.deleteStatus).toBe('failed');
    expect(blocked.job.counters.trashed).toBe(0);

    // A worker restart keeps the run exactly where it was.
    const revived = await rig.restart();
    const afterRestart = await revived.snapshot(false);
    expect(afterRestart.job.runId).toBe(blocked.job.runId);
    expect(afterRestart.job.state).toBe('blocked');
    expect(afterRestart.job.items[0]?.state).toBe('deleteFailed');

    // Resuming works through the rest of the queue but leaves the failed item alone.
    const resumedRig: Rig = { ...rig, coordinator: revived };
    await revived.resumeRun();
    await settle(resumedRig);

    let snapshot = await revived.snapshot(false);
    expect(snapshot.job.counters.trashed).toBe(1);
    expect(snapshot.job.state).toBe('completedWithWarnings');

    // An explicit retry finishes the interrupted item.
    await revived.retryItem(interrupted.internalId);
    await settle(resumedRig);

    snapshot = await revived.snapshot(false);
    expect(snapshot.job.counters.trashed).toBe(2);
    expect(rig.canva.trashedTitles).toHaveLength(2);
  });

  it('purges every local key on request', async () => {
    const rig = await buildRig();
    await prepare(rig, 'dryRun');
    expect(rig.storage.get(STORAGE_KEYS.activeRun)).toBeDefined();

    await rig.coordinator.purgeLocalData();

    expect(rig.storage.get(STORAGE_KEYS.settings)).toBeUndefined();
    expect(rig.storage.get(STORAGE_KEYS.lastReport)).toBeUndefined();
    expect(rig.storage.get(STORAGE_KEYS.logIndex)).toBeUndefined();
  });
});

describe('guard rails at the command surface', () => {
  it('refuses a live mode while live execution is off for the profile', async () => {
    const rig = await buildRig({}, { liveExecutionEnabled: false, disclosureAcceptedAt: null });
    await rig.coordinator.scanTeams();

    const outcome = await rig.coordinator.selectMode('copyVerifyTrash');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('Live execution is off');
  });

  it('refuses to start without the required confirmations', async () => {
    const rig = await buildRig({ copyShowsConfirmation: true });
    await prepare(rig, 'copyVerifyTrash');

    const outcome = await rig.coordinator.startRun();
    expect(outcome.ok).toBe(false);
    expect(rig.canva.countOf('COPY_ITEM')).toBe(0);
  });

  it('refuses a destination that is also a source team', async () => {
    const rig = await buildRig();
    await rig.coordinator.scanTeams();
    await rig.coordinator.selectMode('copyOnly');
    await rig.coordinator.selectTeams([SOURCE.internalId]);
    await rig.coordinator.selectDestination(SOURCE.internalId);
    await rig.coordinator.scanItems();
    await grantEverything(rig);

    const outcome = await rig.coordinator.startRun();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('cannot also be a source team');
  });

  it('skips an excluded item entirely', async () => {
    const rig = await buildRig({ copyShowsConfirmation: true });
    await prepare(rig, 'copyVerifyTrash');

    const snapshot = await rig.coordinator.snapshot(false);
    const excluded = snapshot.job.items[0]!;
    await rig.coordinator.setItemInclusion(excluded.internalId, false);
    await grantEverything(rig);
    await rig.coordinator.startRun();
    await settle(rig);

    expect(rig.canva.copiedTitles).toEqual([snapshot.job.items[1]?.title]);
  });
});

/**
 * Waits for the engine's detached loop to come to rest: nothing in flight and
 * nothing left to plan. Bounded, so a stuck engine fails an assertion rather
 * than hanging the suite.
 */
async function settle(rig: Rig, maxTicks = 2000): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    await immediateWait();
    const snapshot = await rig.coordinator.snapshot(false);
    if (snapshot.engineBusy) continue;
    // Waiting for a leave confirmation is a resting state, not pending work.
    if (snapshot.plan.next === null || snapshot.plan.next.kind === 'awaitLeaveConfirmation') return;
  }
  throw new Error('The engine never came to rest');
}
