/** Builders for test data. Keep these boring: tests should read as scenarios. */

import { createDesignItem, createDestinationFromTeam, createRunJob, withRecomputedCounters } from '../shared/factories';
import { requiredConfirmations } from '../shared/guards';
import { reduceAll, type ReducerContext, type RunEvent } from '../shared/run-state-machine';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { DesignItem, ExecutionMode, RunJob, Settings, Team } from '../shared/types';

export const NOW = '2026-08-04T10:00:00.000Z';

export function ctx(now: string = NOW): ReducerContext {
  return { now };
}

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

export function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    internalId: 'team_source',
    displayName: 'Design Studio',
    workspaceUrl: 'https://www.canva.com/folder/all-projects?brand=BR1',
    leaveSupportedState: 'unknown',
    discoveryTimestamp: NOW,
    isCurrent: true,
    isPersonal: false,
    ...overrides,
  };
}

export function makeDestinationTeam(overrides: Partial<Team> = {}): Team {
  return makeTeam({
    internalId: 'team_personal',
    displayName: 'Personal',
    workspaceUrl: 'https://www.canva.com/folder/all-projects?brand=BR2',
    isCurrent: false,
    isPersonal: true,
    ...overrides,
  });
}

export function makeItem(overrides: Partial<DesignItem> = {}): DesignItem {
  const base = createDesignItem({
    title: 'Quarterly report',
    sourceUrl: 'https://www.canva.com/design/DAF00000001/edit',
    sourceTeamId: 'team_source',
    now: NOW,
    ownerLabel: 'You',
    ownerConfidence: 'high',
    copyCapability: 'available',
    riskFlags: [],
  });
  return { ...base, ...overrides };
}

export function makeItems(count: number, sourceTeamId = 'team_source'): DesignItem[] {
  return Array.from({ length: count }, (_, index) =>
    makeItem({
      internalId: `item_${index + 1}`,
      title: `Design ${index + 1}`,
      sourceUrl: `https://www.canva.com/design/DAF0000000${index + 1}/edit`,
      sourceTeamId,
    }),
  );
}

export function makeJob(overrides: Partial<RunJob> = {}): RunJob {
  const base = createRunJob({
    mode: 'copyVerifyTrash',
    now: NOW,
    settings: makeSettings(),
    selectorMapVersion: 'test-selector-map',
    runId: 'run_test',
  });
  return withRecomputedCounters({ ...base, ...overrides }, NOW);
}

export interface ReadyJobOptions {
  mode?: ExecutionMode;
  itemCount?: number;
  teams?: Team[];
  destination?: Team;
  grantConfirmations?: boolean;
  settings?: Settings;
}

/** A job that has been through discovery and is ready to start. */
export function makeReadyJob(options: ReadyJobOptions = {}): RunJob {
  const mode = options.mode ?? 'copyVerifyTrash';
  const teams = options.teams ?? [makeTeam()];
  const destinationTeam = options.destination ?? makeDestinationTeam();
  const items = (options.teams ?? [makeTeam()]).flatMap((team) =>
    makeItems(options.itemCount ?? 2, team.internalId).map((item) => ({
      ...item,
      internalId: `${team.internalId}_${item.internalId}`,
    })),
  );

  const job = makeJob({
    mode,
    sourceTeams: teams,
    teamQueue: teams.map((team) => team.internalId),
    items,
    destination: createDestinationFromTeam(destinationTeam),
    state: 'reviewReady',
    settings: {
      confirmationItemThreshold: (options.settings ?? makeSettings()).confirmationItemThreshold,
      requireOwnedByMe: (options.settings ?? makeSettings()).requireOwnedByMe,
      selectorMapVersion: 'test-selector-map',
    },
  });

  if (options.grantConfirmations === false) return job;

  return withRecomputedCounters(
    { ...job, confirmations: { ...job.confirmations, scopes: requiredConfirmations(job) } },
    NOW,
  );
}

/** Applies events and returns only the job, for terse assertions. */
export function apply(job: RunJob, events: readonly RunEvent[], now: string = NOW): RunJob {
  return reduceAll(job, events, ctx(now)).job;
}

export function applyWithLogs(job: RunJob, events: readonly RunEvent[], now: string = NOW) {
  return reduceAll(job, events, ctx(now));
}
