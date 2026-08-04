/**
 * Constructors for the canonical entities, plus counter derivation.
 *
 * Counters are always recomputed from `items`, never incremented in place, so a
 * resumed or retried run cannot drift away from the truth.
 */

import { deriveItemId, newRunId } from './ids';
import type {
  DesignItem,
  Destination,
  ExecutionMode,
  ItemType,
  OwnerConfidence,
  RunCounters,
  RunJob,
  Settings,
  Team,
  UserOverrides,
} from './types';

export function emptyCounters(): RunCounters {
  return {
    teamsSelected: 0,
    teamsProcessed: 0,
    teamsLeft: 0,
    itemsFound: 0,
    itemsSelected: 0,
    copied: 0,
    verified: 0,
    trashed: 0,
    failed: 0,
    skipped: 0,
    manualReview: 0,
  };
}

export interface CreateRunJobInput {
  mode: ExecutionMode;
  now: string;
  settings: Settings;
  runId?: string;
  selectorMapVersion: string;
  overrides?: Partial<UserOverrides>;
}

export function createRunJob(input: CreateRunJobInput): RunJob {
  return {
    runId: input.runId ?? newRunId(),
    mode: input.mode,
    createdAt: input.now,
    startedAt: null,
    endedAt: null,
    sourceTeams: [],
    destination: null,
    counters: emptyCounters(),
    state: 'idle',
    userOverrides: {
      allowTrashWithoutVerification:
        input.overrides?.allowTrashWithoutVerification ?? input.settings.overrides.allowTrashWithoutVerification,
      allowLeaveWithUnresolvedItems:
        input.overrides?.allowLeaveWithUnresolvedItems ?? input.settings.overrides.allowLeaveWithUnresolvedItems,
    },
    settings: {
      confirmationItemThreshold: input.settings.confirmationItemThreshold,
      requireOwnedByMe: input.settings.requireOwnedByMe,
      selectorMapVersion: input.selectorMapVersion,
    },
    items: [],
    teamQueue: [],
    processedTeamIds: [],
    leftTeamIds: [],
    activeTeamId: null,
    activeItemId: null,
    currentAction: null,
    confirmations: { scopes: [], leaveConfirmedTeamIds: [] },
    pauseReason: null,
    blocker: null,
    consecutiveFailures: 0,
    manualAssist: null,
    updatedAt: input.now,
  };
}

export interface CreateDesignItemInput {
  title: string;
  sourceUrl: string | null;
  sourceTeamId: string;
  now: string;
  folderPath?: string | null;
  itemType?: ItemType;
  ownerLabel?: string | null;
  ownerConfidence?: OwnerConfidence;
  copyCapability?: DesignItem['copyCapability'];
  riskFlags?: DesignItem['riskFlags'];
  selected?: boolean;
  internalId?: string;
}

export function createDesignItem(input: CreateDesignItemInput): DesignItem {
  const title = input.title.trim();
  const riskFlags = [...(input.riskFlags ?? [])];
  if (title.length === 0 && !riskFlags.includes('titleEmpty')) riskFlags.push('titleEmpty');

  const ownerConfidence = input.ownerConfidence ?? 'unknown';
  if (
    (ownerConfidence === 'low' || ownerConfidence === 'unknown') &&
    !riskFlags.includes('ownershipUnclear')
  ) {
    riskFlags.push('ownershipUnclear');
  }

  return {
    internalId:
      input.internalId ??
      deriveItemId({ sourceUrl: input.sourceUrl, title, sourceTeamId: input.sourceTeamId }),
    title: title.length > 0 ? title : '(untitled design)',
    sourceUrl: input.sourceUrl,
    sourceTeamId: input.sourceTeamId,
    folderPath: input.folderPath ?? null,
    itemType: input.itemType ?? 'design',
    ownerLabel: input.ownerLabel ?? null,
    ownerConfidence,
    discoveredAt: input.now,
    selected: input.selected ?? true,
    state: 'discovered',
    copyStatus: 'pending',
    verificationStatus: 'unverified',
    deleteStatus: 'notRequested',
    copyCapability: input.copyCapability ?? 'unknown',
    copyConfirmationSeen: false,
    riskFlags,
    attempts: { copy: 0, verify: 0, trash: 0 },
    lastError: null,
    notes: [],
  };
}

export function createDestinationFromTeam(team: Team): Destination {
  return {
    kind: 'sameLoginWorkspace',
    teamId: team.internalId,
    displayName: team.displayName,
    workspaceUrl: team.workspaceUrl,
  };
}

export function isVerified(item: DesignItem): boolean {
  return (
    item.verificationStatus === 'strong' ||
    item.verificationStatus === 'weak' ||
    item.verificationStatus === 'manual'
  );
}

/** Terminal item states: the engine will not pick these up again. */
export function isItemResolved(item: DesignItem): boolean {
  return item.state === 'completed' || item.state === 'skipped';
}

export function recomputeCounters(job: RunJob): RunCounters {
  const selectedItems = job.items.filter((item) => item.selected);
  return {
    teamsSelected: job.sourceTeams.length,
    teamsProcessed: job.processedTeamIds.length,
    teamsLeft: job.leftTeamIds.length,
    itemsFound: job.items.length,
    itemsSelected: selectedItems.length,
    copied: job.items.filter((item) => item.copyStatus === 'copied').length,
    verified: job.items.filter(isVerified).length,
    trashed: job.items.filter((item) => item.deleteStatus === 'trashed').length,
    failed: job.items.filter((item) => item.state === 'copyFailed' || item.state === 'deleteFailed').length,
    skipped: job.items.filter((item) => item.state === 'skipped').length,
    manualReview: job.items.filter((item) => item.state === 'manualReviewRequired').length,
  };
}

export function withRecomputedCounters(job: RunJob, now: string): RunJob {
  return { ...job, counters: recomputeCounters(job), updatedAt: now };
}

export function findItem(job: RunJob, itemId: string): DesignItem | undefined {
  return job.items.find((item) => item.internalId === itemId);
}

export function findTeam(job: RunJob, teamId: string): Team | undefined {
  return job.sourceTeams.find((team) => team.internalId === teamId);
}

export function itemsForTeam(job: RunJob, teamId: string): DesignItem[] {
  return job.items.filter((item) => item.sourceTeamId === teamId);
}

export function mapItem(job: RunJob, itemId: string, update: (item: DesignItem) => DesignItem): RunJob {
  let touched = false;
  const items = job.items.map((item) => {
    if (item.internalId !== itemId) return item;
    touched = true;
    return update(item);
  });
  return touched ? { ...job, items } : job;
}
