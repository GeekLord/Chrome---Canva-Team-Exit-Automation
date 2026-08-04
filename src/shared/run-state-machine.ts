/**
 * The run state machine.
 *
 * `reduceRun` is a pure function: `(job, event, ctx) -> { job, logs }`. It owns
 * every state transition for the run and for each item, and it refuses invalid
 * transitions by returning the job unchanged plus a warning log event. Nothing
 * here touches the DOM, `chrome.*`, or the clock — the caller passes `now`.
 *
 * The coordinator in `src/background/` is the only thing that dispatches events,
 * and `planNextAction` (below) is the only thing that decides what happens next.
 */

import type { NormalizedError } from './errors';
import { normalizeError } from './errors';
import {
  findItem,
  findTeam,
  isItemResolved,
  isVerified,
  itemsForTeam,
  mapItem,
  withRecomputedCounters,
} from './factories';
import {
  blockingItems,
  canLeaveTeam,
  canStartRun,
  canTrashItem,
  itemNeedsWork,
  modeAllowsCopy,
  modeAllowsLeave,
  modeAllowsTrash,
  modeAllowsVerify,
  nextItemNeedingWork,
} from './guards';
import type {
  ConfirmationScope,
  CopyCapability,
  DesignItem,
  Destination,
  ExecutionMode,
  LogEventDraft,
  LogLevel,
  LogResultStatus,
  ManualAssistRequest,
  RunJob,
  RunState,
  Team,
  UserOverrides,
  VerificationStatus,
} from './types';

/* ----------------------------------------------------------------- events --- */

export type RunEvent =
  /* discovery */
  | { type: 'TEAM_DISCOVERY_STARTED' }
  | { type: 'TEAMS_DISCOVERED'; count: number }
  | { type: 'TEAM_DISCOVERY_FAILED'; error: NormalizedError }
  | { type: 'TEAMS_SELECTED'; teams: Team[] }
  | { type: 'DESTINATION_SELECTED'; destination: Destination | null }
  | { type: 'MODE_SELECTED'; mode: ExecutionMode }
  | { type: 'ITEM_DISCOVERY_STARTED'; teamId: string }
  | { type: 'ITEMS_DISCOVERED'; teamId: string; items: DesignItem[] }
  | { type: 'ITEM_DISCOVERY_FAILED'; teamId: string; error: NormalizedError }
  | { type: 'ITEM_CAPABILITY_PROBED'; itemId: string; capability: CopyCapability; detail?: string }
  | { type: 'DISCOVERY_COMPLETED' }
  /* review + confirmations */
  | { type: 'ITEM_INCLUSION_SET'; itemId: string; selected: boolean }
  | { type: 'CONFIRMATION_GRANTED'; scope: ConfirmationScope }
  | { type: 'CONFIRMATION_REVOKED'; scope: ConfirmationScope }
  | { type: 'LEAVE_CONFIRMED'; teamId: string }
  | { type: 'OVERRIDES_SET'; overrides: Partial<UserOverrides> }
  /* execution */
  | { type: 'START_REQUESTED' }
  | { type: 'TEAM_STARTED'; teamId: string }
  | { type: 'COPY_STARTED'; itemId: string }
  | { type: 'COPY_SUCCEEDED'; itemId: string; detail?: string; sawConfirmation?: boolean }
  | { type: 'COPY_FAILED'; itemId: string; error: NormalizedError }
  | { type: 'VERIFY_STARTED'; itemId: string }
  | { type: 'VERIFY_SUCCEEDED'; itemId: string; level: 'strong' | 'weak' | 'manual'; detail?: string }
  | { type: 'VERIFY_FAILED'; itemId: string; error: NormalizedError }
  | { type: 'TRASH_STARTED'; itemId: string }
  | { type: 'TRASH_SUCCEEDED'; itemId: string; detail?: string }
  | { type: 'TRASH_FAILED'; itemId: string; error: NormalizedError }
  | { type: 'ITEM_SKIPPED'; itemId: string; reason: string }
  | { type: 'ITEM_RETRY_REQUESTED'; itemId: string }
  | { type: 'MANUAL_ASSIST_REQUESTED'; itemId: string; step: ManualAssistRequest['step']; instruction: string }
  | { type: 'MANUAL_ASSIST_RESOLVED'; itemId: string; outcome: 'done' | 'skip' }
  | { type: 'TEAM_ITEMS_EXHAUSTED'; teamId: string }
  | { type: 'LEAVE_STARTED'; teamId: string }
  | { type: 'LEAVE_SUCCEEDED'; teamId: string }
  | { type: 'LEAVE_FAILED'; teamId: string; error: NormalizedError }
  | { type: 'TEAM_COMPLETED'; teamId: string }
  /* control */
  | { type: 'RUN_RECOVERED'; reason: string }
  | { type: 'CURRENT_ACTION_SET'; text: string | null }
  | { type: 'PAUSE_REQUESTED'; reason?: string }
  | { type: 'RESUME_REQUESTED' }
  | { type: 'STOP_REQUESTED' }
  | { type: 'RUN_BLOCKED'; error: NormalizedError }
  | { type: 'RUN_FINISHED' };

export type RunEventType = RunEvent['type'];

export interface ReducerContext {
  now: string;
}

export interface ReduceResult {
  job: RunJob;
  logs: LogEventDraft[];
}

/* ---------------------------------------------------------------- helpers --- */

const EXECUTING_STATES: readonly RunState[] = ['copying', 'verifying', 'trashing', 'leavingTeam'];

const PRE_RUN_STATES: readonly RunState[] = [
  'idle',
  'discoveringTeams',
  'selectingTeams',
  'discoveringItems',
  'reviewReady',
  'awaitingStartConfirmation',
];

const TERMINAL_STATES: readonly RunState[] = ['completed', 'completedWithWarnings', 'failed'];

export function isExecuting(state: RunState): boolean {
  return EXECUTING_STATES.includes(state);
}

export function isPreRun(state: RunState): boolean {
  return PRE_RUN_STATES.includes(state);
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

interface DraftInput {
  action: string;
  message: string;
  resultStatus: LogResultStatus;
  level?: LogLevel;
  detail?: string | null;
  itemId?: string | null;
  teamId?: string | null;
  verificationLevel?: VerificationStatus | null;
  error?: NormalizedError | null;
  screenshotRef?: string | null;
}

/** Builds a log draft, filling team/item context from the job. */
export function buildLogDraft(job: RunJob, input: DraftInput): LogEventDraft {
  const item = input.itemId ? findItem(job, input.itemId) : undefined;
  const teamId = input.teamId ?? item?.sourceTeamId ?? job.activeTeamId ?? null;
  const team = teamId ? findTeam(job, teamId) : undefined;

  const entityType = input.itemId ? 'item' : teamId ? 'team' : 'run';
  const level: LogLevel =
    input.level ??
    (input.resultStatus === 'failure' || input.resultStatus === 'blocked'
      ? 'error'
      : input.resultStatus === 'skipped'
        ? 'warn'
        : 'info');

  return {
    level,
    entityType,
    entityId: input.itemId ?? teamId ?? null,
    action: input.action,
    message: input.message,
    detail: input.detail ?? input.error?.detail ?? null,
    sourceTeamId: teamId,
    sourceTeamName: team?.displayName ?? null,
    itemTitle: item?.title ?? null,
    resultStatus: input.resultStatus,
    verificationLevel: input.verificationLevel ?? item?.verificationStatus ?? null,
    errorCategory: input.error?.category ?? null,
    screenshotRef: input.screenshotRef ?? null,
  };
}

function settle(job: RunJob, ctx: ReducerContext, logs: LogEventDraft[]): ReduceResult {
  return { job: withRecomputedCounters(job, ctx.now), logs };
}

/** Invalid transition: keep the job as-is, but never fail silently. */
function rejected(job: RunJob, event: RunEvent, reason: string, detail?: string | null): ReduceResult {
  return {
    job,
    logs: [
      buildLogDraft(job, {
        action: `reject:${event.type}`,
        message: `Ignored ${event.type}: ${reason}`,
        resultStatus: 'info',
        level: 'warn',
        detail: detail ?? null,
        itemId: 'itemId' in event ? event.itemId : null,
        teamId: 'teamId' in event ? event.teamId : null,
      }),
    ],
  };
}

function appendNote(item: DesignItem, note: string): string[] {
  return [...item.notes, note];
}

function withoutFlag(item: DesignItem, flag: DesignItem['riskFlags'][number]): DesignItem['riskFlags'] {
  return item.riskFlags.filter((candidate) => candidate !== flag);
}

function withFlag(flags: DesignItem['riskFlags'], flag: DesignItem['riskFlags'][number]): DesignItem['riskFlags'] {
  return flags.includes(flag) ? flags : [...flags, flag];
}

/**
 * Where a paused run should go when resumed. Derived rather than stored so a
 * run recovered from storage lands somewhere consistent with its item states.
 */
export function resolveResumeState(job: RunJob): RunState {
  if (job.activeTeamId) {
    if (nextItemNeedingWork(job, job.activeTeamId)) return 'copying';
    if (modeAllowsLeave(job.mode) && !job.leftTeamIds.includes(job.activeTeamId)) {
      return 'awaitingLeaveConfirmation';
    }
    return 'copying';
  }
  if (job.teamQueue.length > 0) return 'copying';
  if (isPreRun(job.state)) return job.state;
  return blockingItems(job).length > 0 ? 'completedWithWarnings' : 'completed';
}

function finishState(job: RunJob): RunState {
  return blockingItems(job).length > 0 ? 'completedWithWarnings' : 'completed';
}

/* ---------------------------------------------------------------- reducer --- */

export function reduceRun(job: RunJob, event: RunEvent, ctx: ReducerContext): ReduceResult {
  switch (event.type) {
    /* ------------------------------------------------------ discovery --- */

    case 'TEAM_DISCOVERY_STARTED': {
      if (isExecuting(job.state)) return rejected(job, event, 'a run is already executing');
      return settle(
        { ...job, state: 'discoveringTeams', currentAction: 'Scanning teams you can switch into', blocker: null },
        ctx,
        [buildLogDraft(job, { action: 'discoverTeams', message: 'Team discovery started', resultStatus: 'started' })],
      );
    }

    case 'TEAMS_DISCOVERED': {
      return settle({ ...job, state: 'selectingTeams', currentAction: null }, ctx, [
        buildLogDraft(job, {
          action: 'discoverTeams',
          message: `Found ${event.count} workspace(s) in this session`,
          resultStatus: 'success',
        }),
      ]);
    }

    case 'TEAM_DISCOVERY_FAILED': {
      return settle({ ...job, state: 'failed', blocker: event.error, endedAt: ctx.now, currentAction: null }, ctx, [
        buildLogDraft(job, {
          action: 'discoverTeams',
          message: `Team discovery failed: ${event.error.message}`,
          resultStatus: 'failure',
          error: event.error,
        }),
      ]);
    }

    case 'TEAMS_SELECTED': {
      if (!isPreRun(job.state)) return rejected(job, event, 'teams cannot be changed once the run has started');
      const selectedIds = event.teams.map((team) => team.internalId);
      return settle(
        {
          ...job,
          sourceTeams: event.teams,
          teamQueue: selectedIds,
          processedTeamIds: [],
          // Drop items belonging to teams that are no longer in scope.
          items: job.items.filter((item) => selectedIds.includes(item.sourceTeamId)),
          state: 'selectingTeams',
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'selectTeams',
            message: `Selected ${event.teams.length} source team(s)`,
            resultStatus: 'info',
            detail: event.teams.map((team) => team.displayName).join(', ') || null,
          }),
        ],
      );
    }

    case 'DESTINATION_SELECTED': {
      if (!isPreRun(job.state)) return rejected(job, event, 'destination is locked once the run has started');
      return settle({ ...job, destination: event.destination }, ctx, [
        buildLogDraft(job, {
          action: 'selectDestination',
          message: event.destination
            ? `Destination set to "${event.destination.displayName}"`
            : 'Destination cleared',
          resultStatus: 'info',
        }),
      ]);
    }

    case 'MODE_SELECTED': {
      if (!isPreRun(job.state)) return rejected(job, event, 'mode is locked once the run has started');
      // Changing the mode invalidates prior confirmations on purpose.
      return settle(
        {
          ...job,
          mode: event.mode,
          confirmations: { scopes: [], leaveConfirmedTeamIds: [] },
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'selectMode',
            message: `Execution mode set to "${event.mode}". Confirmations reset.`,
            resultStatus: 'info',
          }),
        ],
      );
    }

    case 'ITEM_DISCOVERY_STARTED': {
      if (!findTeam(job, event.teamId)) return rejected(job, event, 'team is not part of this run');
      return settle(
        {
          ...job,
          state: 'discoveringItems',
          activeTeamId: event.teamId,
          currentAction: `Scanning designs in "${findTeam(job, event.teamId)?.displayName ?? event.teamId}"`,
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'discoverItems',
            message: 'Item discovery started',
            resultStatus: 'started',
            teamId: event.teamId,
          }),
        ],
      );
    }

    case 'ITEMS_DISCOVERED': {
      if (!findTeam(job, event.teamId)) return rejected(job, event, 'team is not part of this run');

      const previous = new Map(itemsForTeam(job, event.teamId).map((item) => [item.internalId, item]));
      const deduped = new Map<string, DesignItem>();
      for (const incoming of event.items) {
        const prior = previous.get(incoming.internalId);
        if (prior) {
          // Preserve progress across re-scans and resumes.
          deduped.set(incoming.internalId, {
            ...prior,
            title: incoming.title,
            sourceUrl: incoming.sourceUrl ?? prior.sourceUrl,
            folderPath: incoming.folderPath ?? prior.folderPath,
            ownerLabel: incoming.ownerLabel ?? prior.ownerLabel,
            ownerConfidence: incoming.ownerConfidence,
            copyCapability: incoming.copyCapability === 'unknown' ? prior.copyCapability : incoming.copyCapability,
            riskFlags: Array.from(new Set([...prior.riskFlags, ...incoming.riskFlags])),
          });
        } else {
          deduped.set(incoming.internalId, incoming);
        }
      }

      const others = job.items.filter((item) => item.sourceTeamId !== event.teamId);
      const rediscovered = [...deduped.values()];
      const dropped = [...previous.keys()].filter((id) => !deduped.has(id)).length;

      return settle({ ...job, items: [...others, ...rediscovered], currentAction: null }, ctx, [
        buildLogDraft(job, {
          action: 'discoverItems',
          message: `Discovered ${rediscovered.length} item(s)`,
          resultStatus: 'success',
          teamId: event.teamId,
          detail: dropped > 0 ? `${dropped} previously seen item(s) no longer listed` : null,
        }),
      ]);
    }

    case 'ITEM_DISCOVERY_FAILED': {
      return settle({ ...job, currentAction: null, blocker: event.error, state: 'paused', pauseReason: event.error.message }, ctx, [
        buildLogDraft(job, {
          action: 'discoverItems',
          message: `Item discovery failed: ${event.error.message}`,
          resultStatus: 'failure',
          teamId: event.teamId,
          error: event.error,
        }),
      ]);
    }

    case 'ITEM_CAPABILITY_PROBED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      const nextJob = mapItem(job, event.itemId, (current) => {
        let flags = withoutFlag(current, 'copyActionUnknown');
        if (event.capability === 'unavailable') flags = withFlag(flags, 'copyActionMissing');
        if (event.capability === 'unknown') flags = withFlag(flags, 'copyActionUnknown');
        return { ...current, copyCapability: event.capability, riskFlags: flags };
      });
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'probeCopyCapability',
          message: `Copy capability: ${event.capability}`,
          resultStatus: 'info',
          itemId: event.itemId,
          detail: event.detail ?? null,
        }),
      ]);
    }

    case 'DISCOVERY_COMPLETED': {
      return settle({ ...job, state: 'reviewReady', activeTeamId: null, currentAction: null }, ctx, [
        buildLogDraft(job, {
          action: 'discovery',
          message: `Discovery complete: ${job.items.length} item(s) across ${job.sourceTeams.length} team(s)`,
          resultStatus: 'success',
        }),
      ]);
    }

    /* ------------------------------------------------- review + consent --- */

    case 'ITEM_INCLUSION_SET': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      if (isExecuting(job.state)) {
        return rejected(job, event, 'pause the run before changing which items are included');
      }
      const nextJob = mapItem(job, event.itemId, (current) => ({
        ...current,
        selected: event.selected,
        state: event.selected && current.state === 'discovered' ? 'discovered' : current.state,
      }));
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'setInclusion',
          message: event.selected ? 'Item included' : 'Item excluded',
          resultStatus: 'info',
          itemId: event.itemId,
        }),
      ]);
    }

    case 'CONFIRMATION_GRANTED': {
      if (job.confirmations.scopes.includes(event.scope)) return { job, logs: [] };
      return settle(
        { ...job, confirmations: { ...job.confirmations, scopes: [...job.confirmations.scopes, event.scope] } },
        ctx,
        [
          buildLogDraft(job, {
            action: 'confirm',
            message: `Confirmation granted: ${event.scope}`,
            resultStatus: 'info',
          }),
        ],
      );
    }

    case 'CONFIRMATION_REVOKED': {
      return settle(
        {
          ...job,
          confirmations: {
            ...job.confirmations,
            scopes: job.confirmations.scopes.filter((scope) => scope !== event.scope),
          },
        },
        ctx,
        [buildLogDraft(job, { action: 'confirm', message: `Confirmation revoked: ${event.scope}`, resultStatus: 'info' })],
      );
    }

    case 'LEAVE_CONFIRMED': {
      if (!findTeam(job, event.teamId)) return rejected(job, event, 'team is not part of this run');
      if (job.confirmations.leaveConfirmedTeamIds.includes(event.teamId)) return { job, logs: [] };
      return settle(
        {
          ...job,
          confirmations: {
            ...job.confirmations,
            leaveConfirmedTeamIds: [...job.confirmations.leaveConfirmedTeamIds, event.teamId],
          },
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'confirmLeave',
            message: 'Leaving this team was confirmed by the operator',
            resultStatus: 'info',
            teamId: event.teamId,
          }),
        ],
      );
    }

    case 'OVERRIDES_SET': {
      if (isExecuting(job.state)) return rejected(job, event, 'pause the run before changing overrides');
      const overrides: UserOverrides = { ...job.userOverrides, ...event.overrides };
      const changed = Object.entries(overrides)
        .filter(([key, value]) => job.userOverrides[key as keyof UserOverrides] !== value)
        .map(([key, value]) => `${key}=${String(value)}`);
      return settle({ ...job, userOverrides: overrides }, ctx, [
        buildLogDraft(job, {
          action: 'setOverrides',
          message: changed.length > 0 ? `Advanced overrides changed: ${changed.join(', ')}` : 'Overrides unchanged',
          resultStatus: 'info',
          level: changed.length > 0 ? 'warn' : 'info',
        }),
      ]);
    }

    /* ------------------------------------------------------- execution --- */

    case 'START_REQUESTED': {
      if (job.mode === 'dryRun') {
        return rejected(job, event, 'dry run has no execution phase; it finishes at the review summary');
      }
      if (isExecuting(job.state)) return rejected(job, event, 'run is already executing');
      const guard = canStartRun(job);
      if (!guard.allowed) return rejected(job, event, guard.reason);

      return settle(
        {
          ...job,
          state: 'copying',
          startedAt: job.startedAt ?? ctx.now,
          pauseReason: null,
          blocker: null,
          consecutiveFailures: 0,
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'startRun',
            message: `Run started in mode "${job.mode}" for ${job.counters.itemsSelected} item(s)`,
            resultStatus: 'started',
            detail: `destination=${job.destination?.displayName ?? 'none'}; overrides=${JSON.stringify(job.userOverrides)}`,
          }),
        ],
      );
    }

    case 'TEAM_STARTED': {
      if (!findTeam(job, event.teamId)) return rejected(job, event, 'team is not part of this run');
      return settle(
        {
          ...job,
          activeTeamId: event.teamId,
          teamQueue: job.teamQueue.filter((id) => id !== event.teamId),
          state: 'copying',
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'startTeam',
            message: 'Started processing team',
            resultStatus: 'started',
            teamId: event.teamId,
          }),
        ],
      );
    }

    case 'COPY_STARTED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      if (!modeAllowsCopy(job.mode)) return rejected(job, event, 'dry run never copies');
      if (!item.selected) return rejected(job, event, 'item is excluded from this run');
      if (item.copyStatus === 'copied') return rejected(job, event, 'item was already copied');

      const nextJob = mapItem(
        { ...job, state: 'copying', activeItemId: event.itemId, currentAction: `Copying "${item.title}"` },
        event.itemId,
        (current) => ({
          ...current,
          state: 'copyInProgress',
          copyStatus: 'inProgress',
          attempts: { ...current.attempts, copy: current.attempts.copy + 1 },
        }),
      );
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'copyItem',
          message: `Copy attempt ${item.attempts.copy + 1} for "${item.title}"`,
          resultStatus: 'started',
          itemId: event.itemId,
        }),
      ]);
    }

    case 'COPY_SUCCEEDED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');

      const finishesHere = !modeAllowsVerify(job.mode);
      const nextJob = mapItem({ ...job, consecutiveFailures: 0 }, event.itemId, (current) => ({
        ...current,
        copyStatus: 'copied',
        state: finishesHere ? 'completed' : 'copied',
        copyConfirmationSeen: event.sawConfirmation ?? false,
        lastError: null,
        notes: appendNote(current, `Copied to ${job.destination?.displayName ?? 'destination'} at ${ctx.now}`),
      }));
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'copyItem',
          message: `Copied "${item.title}"`,
          resultStatus: 'success',
          itemId: event.itemId,
          detail: event.detail ?? null,
        }),
      ]);
    }

    case 'COPY_FAILED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      const nextJob = mapItem(
        { ...job, consecutiveFailures: job.consecutiveFailures + 1, currentAction: null },
        event.itemId,
        (current) => ({
          ...current,
          state: 'copyFailed',
          copyStatus: 'failed',
          lastError: event.error,
          notes: appendNote(current, `Copy failed: ${event.error.message}`),
        }),
      );
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'copyItem',
          message: `Copy failed for "${item.title}": ${event.error.message}`,
          resultStatus: 'failure',
          itemId: event.itemId,
          error: event.error,
        }),
      ]);
    }

    case 'VERIFY_STARTED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      if (item.copyStatus !== 'copied') return rejected(job, event, 'nothing to verify until the copy succeeds');

      const nextJob = mapItem(
        { ...job, state: 'verifying', activeItemId: event.itemId, currentAction: `Verifying copy of "${item.title}"` },
        event.itemId,
        (current) => ({ ...current, attempts: { ...current.attempts, verify: current.attempts.verify + 1 } }),
      );
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'verifyCopy',
          message: `Verifying copy of "${item.title}"`,
          resultStatus: 'started',
          itemId: event.itemId,
        }),
      ]);
    }

    case 'VERIFY_SUCCEEDED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      if (item.copyStatus !== 'copied') return rejected(job, event, 'cannot verify an item that was not copied');

      const finishesHere = !modeAllowsTrash(job.mode);
      const nextJob = mapItem({ ...job, consecutiveFailures: 0 }, event.itemId, (current) => ({
        ...current,
        verificationStatus: event.level,
        state: finishesHere ? 'completed' : 'copyVerified',
        lastError: null,
        notes: appendNote(current, `Verification (${event.level}): ${event.detail ?? 'confirmed'}`),
      }));
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'verifyCopy',
          message: `Copy verified (${event.level}) for "${item.title}"`,
          resultStatus: 'success',
          itemId: event.itemId,
          verificationLevel: event.level,
          detail: event.detail ?? null,
        }),
      ]);
    }

    case 'VERIFY_FAILED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      // The copy exists but is unproven, so the original must stay put.
      const nextJob = mapItem(
        { ...job, consecutiveFailures: job.consecutiveFailures + 1, currentAction: null },
        event.itemId,
        (current) => ({
          ...current,
          verificationStatus: 'failed',
          state: 'manualReviewRequired',
          lastError: event.error,
          notes: appendNote(current, `Verification failed: ${event.error.message}. Original left in place.`),
        }),
      );
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'verifyCopy',
          message: `Could not verify copy of "${item.title}". Original left in place.`,
          resultStatus: 'failure',
          itemId: event.itemId,
          verificationLevel: 'failed',
          error: event.error,
        }),
      ]);
    }

    case 'TRASH_STARTED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');

      const guard = canTrashItem(job, item);
      if (!guard.allowed) {
        // Defence in depth: the planner should never get here. Park the item for
        // review so the engine cannot spin on it.
        const blocked = normalizeError({
          category: guard.category,
          message: `Refused to trash "${item.title}"`,
          detail: guard.reason,
        });
        const parked = mapItem(job, event.itemId, (current) => ({
          ...current,
          state: 'manualReviewRequired',
          deleteStatus: 'blocked',
          lastError: blocked,
          notes: appendNote(current, `Trash blocked: ${guard.reason}`),
        }));
        return settle(parked, ctx, [
          buildLogDraft(job, {
            action: 'trashItem',
            message: `Refused to trash "${item.title}": ${guard.reason}`,
            resultStatus: 'blocked',
            itemId: event.itemId,
            level: 'error',
            error: blocked,
          }),
        ]);
      }

      const nextJob = mapItem(
        {
          ...job,
          state: 'trashing',
          activeItemId: event.itemId,
          currentAction: `Moving original of "${item.title}" to trash`,
        },
        event.itemId,
        (current) => ({
          ...current,
          state: 'deleteInProgress',
          deleteStatus: 'inProgress',
          attempts: { ...current.attempts, trash: current.attempts.trash + 1 },
        }),
      );
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'trashItem',
          message: `Moving original of "${item.title}" to trash (verification: ${item.verificationStatus})`,
          resultStatus: 'started',
          itemId: event.itemId,
        }),
      ]);
    }

    case 'TRASH_SUCCEEDED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      const nextJob = mapItem({ ...job, consecutiveFailures: 0 }, event.itemId, (current) => ({
        ...current,
        deleteStatus: 'trashed',
        state: 'completed',
        lastError: null,
        notes: appendNote(current, `Original moved to trash at ${ctx.now}`),
      }));
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'trashItem',
          message: `Original of "${item.title}" moved to trash`,
          resultStatus: 'success',
          itemId: event.itemId,
          detail: event.detail ?? null,
        }),
      ]);
    }

    case 'TRASH_FAILED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      const nextJob = mapItem(
        { ...job, consecutiveFailures: job.consecutiveFailures + 1, currentAction: null },
        event.itemId,
        (current) => ({
          ...current,
          deleteStatus: 'failed',
          state: 'deleteFailed',
          lastError: event.error,
          notes: appendNote(current, `Trash failed: ${event.error.message}`),
        }),
      );
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'trashItem',
          message: `Could not trash original of "${item.title}": ${event.error.message}`,
          resultStatus: 'failure',
          itemId: event.itemId,
          error: event.error,
        }),
      ]);
    }

    case 'ITEM_SKIPPED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      const nextJob = mapItem({ ...job, activeItemId: null }, event.itemId, (current) => ({
        ...current,
        state: 'skipped',
        copyStatus: current.copyStatus === 'pending' || current.copyStatus === 'inProgress' ? 'skipped' : current.copyStatus,
        notes: appendNote(current, `Skipped: ${event.reason}`),
      }));
      return settle(nextJob, ctx, [
        buildLogDraft(job, {
          action: 'skipItem',
          message: `Skipped "${item.title}": ${event.reason}`,
          resultStatus: 'skipped',
          itemId: event.itemId,
        }),
      ]);
    }

    case 'ITEM_RETRY_REQUESTED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      if (itemNeedsWork(item)) return rejected(job, event, 'item is already queued for work');

      const reset: DesignItem =
        item.copyStatus !== 'copied'
          ? { ...item, state: 'copyPending', copyStatus: 'pending', deleteStatus: 'notRequested' }
          : !isVerified(item)
            ? { ...item, state: 'copied', verificationStatus: 'unverified' }
            : { ...item, state: 'copyVerified', deleteStatus: 'pending' };

      const nextJob = mapItem({ ...job, consecutiveFailures: 0, blocker: null }, event.itemId, () => ({
        ...reset,
        selected: true,
        lastError: null,
        notes: appendNote(item, 'Retry requested by operator'),
      }));

      /**
       * Retrying after the run finished reopens it, otherwise the retry would be
       * queued into a terminal run and never execute. The item's team stops
       * counting as processed until it is worked through again.
       */
      const reopening = isTerminal(job.state);
      const reopened: RunJob = reopening
        ? {
            ...nextJob,
            state: 'copying',
            endedAt: null,
            activeTeamId: item.sourceTeamId,
            processedTeamIds: nextJob.processedTeamIds.filter((id) => id !== item.sourceTeamId),
          }
        : nextJob;

      return settle(reopened, ctx, [
        buildLogDraft(job, {
          action: 'retryItem',
          message: reopening
            ? `Retry queued for "${item.title}"; the finished run was reopened`
            : `Retry queued for "${item.title}"`,
          resultStatus: 'info',
          itemId: event.itemId,
        }),
      ]);
    }

    case 'MANUAL_ASSIST_REQUESTED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      return settle(
        {
          ...job,
          state: 'paused',
          pauseReason: `Manual step needed for "${item.title}"`,
          manualAssist: { itemId: event.itemId, step: event.step, instruction: event.instruction, raisedAt: ctx.now },
          currentAction: event.instruction,
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'manualAssist',
            message: `Manual assist requested (${event.step}) for "${item.title}"`,
            resultStatus: 'info',
            level: 'warn',
            itemId: event.itemId,
            detail: event.instruction,
          }),
        ],
      );
    }

    case 'MANUAL_ASSIST_RESOLVED': {
      const item = findItem(job, event.itemId);
      if (!item) return rejected(job, event, 'unknown item');
      if (job.manualAssist?.itemId !== event.itemId) return rejected(job, event, 'no manual assist pending for this item');
      const step = job.manualAssist.step;

      if (event.outcome === 'skip') {
        const skipped = mapItem(
          { ...job, manualAssist: null, state: resolveResumeState(job), pauseReason: null },
          event.itemId,
          (current) => ({
            ...current,
            state: 'skipped',
            notes: appendNote(current, `Manual ${step} declined by operator`),
          }),
        );
        return settle(skipped, ctx, [
          buildLogDraft(job, {
            action: 'manualAssist',
            message: `Operator skipped manual ${step} for "${item.title}"`,
            resultStatus: 'skipped',
            itemId: event.itemId,
          }),
        ]);
      }

      const applied = mapItem(
        { ...job, manualAssist: null, pauseReason: null, consecutiveFailures: 0 },
        event.itemId,
        (current) => {
          if (step === 'copy') {
            return {
              ...current,
              copyStatus: 'copied',
              verificationStatus: 'manual',
              state: modeAllowsTrash(job.mode) ? 'copyVerified' : 'completed',
              notes: appendNote(current, 'Operator confirmed the copy manually'),
            };
          }
          if (step === 'verify') {
            return {
              ...current,
              verificationStatus: 'manual',
              state: modeAllowsTrash(job.mode) ? 'copyVerified' : 'completed',
              notes: appendNote(current, 'Operator verified the copy manually'),
            };
          }
          return {
            ...current,
            deleteStatus: 'trashed',
            state: 'completed',
            notes: appendNote(current, 'Operator trashed the original manually'),
          };
        },
      );
      return settle({ ...applied, state: resolveResumeState(applied) }, ctx, [
        buildLogDraft(job, {
          action: 'manualAssist',
          message: `Operator confirmed manual ${step} for "${item.title}"`,
          resultStatus: 'success',
          itemId: event.itemId,
          verificationLevel: step === 'trash' ? null : 'manual',
        }),
      ]);
    }

    case 'TEAM_ITEMS_EXHAUSTED': {
      if (job.activeTeamId !== event.teamId) return rejected(job, event, 'team is not the active team');
      const needsLeave = modeAllowsLeave(job.mode) && !job.leftTeamIds.includes(event.teamId);
      return settle(
        {
          ...job,
          activeItemId: null,
          currentAction: null,
          state: needsLeave ? 'awaitingLeaveConfirmation' : job.state,
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'teamItemsExhausted',
            message: needsLeave
              ? 'All items processed. Waiting for leave confirmation.'
              : 'All items processed for this team.',
            resultStatus: 'info',
            teamId: event.teamId,
          }),
        ],
      );
    }

    case 'LEAVE_STARTED': {
      const guard = canLeaveTeam(job, event.teamId);
      if (!guard.allowed) return rejected(job, event, guard.reason);
      const team = findTeam(job, event.teamId);
      return settle(
        { ...job, state: 'leavingTeam', currentAction: `Leaving "${team?.displayName ?? event.teamId}"` },
        ctx,
        [
          buildLogDraft(job, {
            action: 'leaveTeam',
            message: 'Leave action started',
            resultStatus: 'started',
            teamId: event.teamId,
          }),
        ],
      );
    }

    case 'LEAVE_SUCCEEDED': {
      const team = findTeam(job, event.teamId);
      if (!team) return rejected(job, event, 'team is not part of this run');
      return settle(
        {
          ...job,
          leftTeamIds: job.leftTeamIds.includes(event.teamId) ? job.leftTeamIds : [...job.leftTeamIds, event.teamId],
          sourceTeams: job.sourceTeams.map((candidate) =>
            candidate.internalId === event.teamId ? { ...candidate, leaveSupportedState: 'available' } : candidate,
          ),
          currentAction: null,
          consecutiveFailures: 0,
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'leaveTeam',
            message: `Left team "${team.displayName}"`,
            resultStatus: 'success',
            teamId: event.teamId,
          }),
        ],
      );
    }

    case 'LEAVE_FAILED': {
      const team = findTeam(job, event.teamId);
      if (!team) return rejected(job, event, 'team is not part of this run');
      const blockedByPolicy = event.error.category === 'leave_blocked_by_policy';
      return settle(
        {
          ...job,
          sourceTeams: job.sourceTeams.map((candidate) =>
            candidate.internalId === event.teamId
              ? { ...candidate, leaveSupportedState: blockedByPolicy ? 'blockedByPolicy' : candidate.leaveSupportedState }
              : candidate,
          ),
          // Withdraw the per-team confirmation so the engine cannot loop on a
          // failing leave attempt: retrying needs a fresh, deliberate confirm.
          confirmations: {
            ...job.confirmations,
            leaveConfirmedTeamIds: job.confirmations.leaveConfirmedTeamIds.filter((id) => id !== event.teamId),
          },
          state: 'awaitingLeaveConfirmation',
          currentAction: null,
          // Not a hard stop: other queued teams can still be processed.
          blocker: blockedByPolicy ? job.blocker : event.error,
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'leaveTeam',
            message: `Could not leave "${team.displayName}": ${event.error.message}`,
            resultStatus: blockedByPolicy ? 'blocked' : 'failure',
            teamId: event.teamId,
            error: event.error,
          }),
        ],
      );
    }

    case 'TEAM_COMPLETED': {
      if (!findTeam(job, event.teamId)) return rejected(job, event, 'team is not part of this run');
      return settle(
        {
          ...job,
          processedTeamIds: job.processedTeamIds.includes(event.teamId)
            ? job.processedTeamIds
            : [...job.processedTeamIds, event.teamId],
          teamQueue: job.teamQueue.filter((id) => id !== event.teamId),
          activeTeamId: job.activeTeamId === event.teamId ? null : job.activeTeamId,
          activeItemId: null,
          currentAction: null,
        },
        ctx,
        [
          buildLogDraft(job, {
            action: 'teamCompleted',
            message: 'Finished processing team',
            resultStatus: 'success',
            teamId: event.teamId,
          }),
        ],
      );
    }

    /* --------------------------------------------------------- control --- */

    case 'RUN_RECOVERED': {
      /**
       * Recovery bias: an interrupted copy is safe to redo (a duplicate in the
       * destination is recoverable), but an interrupted trash needs human eyes
       * because we cannot tell whether it landed.
       */
      const logs: LogEventDraft[] = [];
      const items = job.items.map((item) => {
        if (item.state === 'copyInProgress') {
          logs.push(
            buildLogDraft(job, {
              action: 'recover',
              message: `Requeued "${item.title}" for copy after an interrupted attempt`,
              resultStatus: 'info',
              level: 'warn',
              itemId: item.internalId,
              detail: event.reason,
            }),
          );
          return {
            ...item,
            state: 'copyPending' as const,
            copyStatus: 'pending' as const,
            notes: appendNote(item, `Copy was interrupted (${event.reason}); requeued. Check for a duplicate copy.`),
          };
        }
        if (item.state === 'deleteInProgress') {
          logs.push(
            buildLogDraft(job, {
              action: 'recover',
              message: `"${item.title}" needs review: a trash action was interrupted`,
              resultStatus: 'blocked',
              level: 'error',
              itemId: item.internalId,
              detail: event.reason,
            }),
          );
          return {
            ...item,
            state: 'manualReviewRequired' as const,
            deleteStatus: 'blocked' as const,
            lastError: normalizeError({
              category: 'delete_failed',
              message: 'A move-to-trash action was interrupted',
              detail: `${event.reason}. Check whether the original is in the source team or in Canva's trash.`,
            }),
            notes: appendNote(item, `Trash was interrupted (${event.reason}); parked for review.`),
          };
        }
        return item;
      });

      const state: RunState = isExecuting(job.state) ? 'paused' : job.state;
      logs.push(
        buildLogDraft(job, {
          action: 'recover',
          message: `Run state recovered: ${event.reason}`,
          resultStatus: 'info',
          level: 'warn',
        }),
      );

      return settle(
        {
          ...job,
          items,
          state,
          pauseReason: state === 'paused' ? `Recovered: ${event.reason}` : job.pauseReason,
          currentAction: null,
        },
        ctx,
        logs,
      );
    }

    case 'CURRENT_ACTION_SET': {
      if (job.currentAction === event.text) return { job, logs: [] };
      return { job: { ...job, currentAction: event.text, updatedAt: ctx.now }, logs: [] };
    }

    case 'PAUSE_REQUESTED': {
      if (isTerminal(job.state)) return rejected(job, event, 'run already finished');
      if (job.state === 'paused') return { job, logs: [] };
      return settle(
        { ...job, state: 'paused', pauseReason: event.reason ?? 'Paused by operator', currentAction: null },
        ctx,
        [
          buildLogDraft(job, {
            action: 'pauseRun',
            message: `Run paused: ${event.reason ?? 'operator request'}`,
            resultStatus: 'info',
            level: 'warn',
          }),
        ],
      );
    }

    case 'RESUME_REQUESTED': {
      if (job.state !== 'paused' && job.state !== 'blocked') {
        return rejected(job, event, `cannot resume from state "${job.state}"`);
      }
      if (job.manualAssist) return rejected(job, event, 'resolve the pending manual step first');
      return settle(
        { ...job, state: resolveResumeState(job), pauseReason: null, blocker: null, consecutiveFailures: 0 },
        ctx,
        [buildLogDraft(job, { action: 'resumeRun', message: 'Run resumed', resultStatus: 'info' })],
      );
    }

    case 'STOP_REQUESTED': {
      if (isTerminal(job.state)) return { job, logs: [] };
      const state = finishState(job);
      return settle(
        { ...job, state, endedAt: ctx.now, currentAction: null, activeItemId: null, pauseReason: null },
        ctx,
        [
          buildLogDraft(job, {
            action: 'stopRun',
            message: 'Run stopped by operator',
            resultStatus: 'info',
            level: 'warn',
          }),
        ],
      );
    }

    case 'RUN_BLOCKED': {
      return settle({ ...job, state: 'blocked', blocker: event.error, currentAction: null }, ctx, [
        buildLogDraft(job, {
          action: 'blockRun',
          message: `Run halted: ${event.error.message}`,
          resultStatus: 'blocked',
          level: 'error',
          error: event.error,
        }),
      ]);
    }

    case 'RUN_FINISHED': {
      if (isTerminal(job.state)) return { job, logs: [] };
      const state = finishState(job);
      return settle({ ...job, state, endedAt: ctx.now, currentAction: null, activeItemId: null }, ctx, [
        buildLogDraft(job, {
          action: 'finishRun',
          message: state === 'completed' ? 'Run completed' : 'Run completed with warnings',
          resultStatus: state === 'completed' ? 'success' : 'info',
          level: state === 'completed' ? 'info' : 'warn',
        }),
      ]);
    }

    default: {
      const exhaustive: never = event;
      return rejected(job, exhaustive as RunEvent, 'unhandled event type');
    }
  }
}

/** Applies a sequence of events, threading the job through each one. */
export function reduceAll(job: RunJob, events: readonly RunEvent[], ctx: ReducerContext): ReduceResult {
  return events.reduce<ReduceResult>(
    (accumulator, event) => {
      const next = reduceRun(accumulator.job, event, ctx);
      return { job: next.job, logs: [...accumulator.logs, ...next.logs] };
    },
    { job, logs: [] },
  );
}

/** True when every selected item in the team is resolved one way or another. */
export function teamItemsExhausted(job: RunJob, teamId: string): boolean {
  return itemsForTeam(job, teamId)
    .filter((item) => item.selected)
    .every((item) => isItemResolved(item) || !itemNeedsWork(item));
}
