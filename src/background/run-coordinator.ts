/**
 * The run engine.
 *
 * Responsibilities:
 *   - own the single `RunJob` and persist every transition
 *   - translate operator commands into state-machine events
 *   - execute exactly one planned action at a time, sequentially
 *   - apply pacing, bounded retries, backoff and the failure circuit breaker
 *   - halt on auth or abuse screens, and offer manual assist where automation
 *     confidence runs out
 *
 * It never decides safety policy on its own: `guards.ts` and the reducer do
 * that, and this class refuses to run anything the planner did not propose.
 */

import { LogStore } from '../logging/log-store';
import {
  DEFAULT_ACTION_TIMEOUT_MS,
  EXECUTION_MODE_LABELS,
  SNAPSHOT_BROADCAST_DEBOUNCE_MS,
} from '../shared/constants';
import {
  isHaltingCategory,
  normalizeError,
  toNormalizedError,
  type ErrorCategory,
  type NormalizedError,
} from '../shared/errors';
import {
  createDestinationFromTeam,
  createRunJob,
  findItem,
  findTeam,
  itemsForTeam,
} from '../shared/factories';
import { canStartRun, missingConfirmations, requiredConfirmations } from '../shared/guards';
import {
  copyItemResultSchema,
  discoverItemsResultSchema,
  discoverTeamsResultSchema,
  highlightResultSchema,
  probeItemResultSchema,
  simpleActionResultSchema,
  verifyCopyResultSchema,
  type ActionOptions,
  type BroadcastMessage,
  type PageStatus,
  type RunSnapshot,
} from '../shared/messages';
import { describePlannedAction, planNextAction, remainingWorkCount, type PlannedAction } from '../shared/planner';
import { buildRunReport } from '../shared/report';
import { isExecuting, reduceAll, type RunEvent } from '../shared/run-state-machine';
import { DEFAULT_SETTINGS, liveExecutionAllowed } from '../shared/settings';
import type {
  DesignItem,
  ExecutionMode,
  LogEvent,
  LogEventDraft,
  RunJob,
  Settings,
  Team,
  UserOverrides,
} from '../shared/types';

import { actionDelay, KeepAlive, retryDelay, sleep, streakDelay } from './pacing';
import type { ExtensionStore } from './storage';
import { ContentActionFailure, TabController } from './tab-controller';

/** Failures where asking the operator to do the step by hand is reasonable. */
const MANUAL_ASSIST_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'selector_not_found',
  'dialog_not_opened',
  'copy_action_missing',
  'copy_verification_failed',
  'delete_action_missing',
]);

/** Backstop against a planner/reducer bug turning into a spin. */
const MAX_LOOP_ITERATIONS = 5000;

const SELECTOR_MAP_VERSION_PLACEHOLDER = 'unknown';

export type StepKind = 'copy' | 'verify' | 'trash';

export interface CommandOutcome {
  ok: boolean;
  message?: string;
  category?: ErrorCategory;
  nextStep?: string | null;
}

const OK: CommandOutcome = { ok: true };

function fail(message: string, category: ErrorCategory = 'unknown', nextStep: string | null = null): CommandOutcome {
  return { ok: false, message, category, nextStep };
}

/**
 * Worker eviction is routine in MV3, so recovery only logs when something was
 * genuinely mid-flight.
 */
function needsRecovery(job: RunJob): boolean {
  if (isExecuting(job.state)) return true;
  return job.items.some((item) => item.state === 'copyInProgress' || item.state === 'deleteInProgress');
}

function disconnectedPage(): PageStatus {
  return {
    detected: false,
    tabId: null,
    url: null,
    loggedIn: 'unknown',
    currentWorkspaceName: null,
    view: 'unknown',
    interruption: 'none',
    selectorMapVersion: SELECTOR_MAP_VERSION_PLACEHOLDER,
    checkedAt: new Date().toISOString(),
  };
}

export interface CoordinatorDeps {
  /**
   * Injectable wait. Production uses the real pacing; integration tests pass a
   * no-op so the whole state machine can be exercised without wall-clock delay.
   */
  wait?: (ms: number) => Promise<void>;
}

export class RunCoordinator {
  private job: RunJob | null = null;
  private discoveredTeams: Team[] = [];
  private settings: Settings = DEFAULT_SETTINGS;
  private page: PageStatus = disconnectedPage();
  private recentLogs: LogEvent[] = [];
  private engineBusy = false;
  private loopRunning = false;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly keepAlive = new KeepAlive();

  private readonly wait: (ms: number) => Promise<void>;

  constructor(
    private readonly store: ExtensionStore,
    private readonly logs: LogStore,
    private readonly tabs: TabController,
    private readonly publish: (message: BroadcastMessage) => void,
    deps: CoordinatorDeps = {},
  ) {
    this.wait = deps.wait ?? sleep;
  }

  /* ------------------------------------------------------------- lifecycle --- */

  async init(): Promise<void> {
    const settings = await this.store.loadSettings();
    this.settings = settings.value;
    this.logs.setOptions({ maxEventsPerRun: this.settings.logRetentionMaxEvents });

    const stored = await this.store.loadRun();
    this.job = stored.value;

    if (this.job) {
      this.recentLogs = await this.logs.tail(this.job.runId, 50);
      if (needsRecovery(this.job)) {
        await this.dispatch([{ type: 'RUN_RECOVERED', reason: 'the extension service worker restarted' }]);
      }
    }

    if (settings.issue) {
      await this.logSystem('warn', 'settingsRecovered', settings.issue);
    }
    if (stored.issue) {
      await this.logSystem('warn', 'runRecovered', stored.issue);
    }
  }

  private async ensureJob(): Promise<RunJob> {
    if (this.job) return this.job;
    const job = createRunJob({
      mode: this.settings.defaultMode,
      now: new Date().toISOString(),
      settings: this.settings,
      selectorMapVersion: this.page.selectorMapVersion,
    });
    this.job = job;
    await this.store.saveRun(job);
    return job;
  }

  /* -------------------------------------------------------------- snapshot --- */

  async snapshot(refreshPage = true): Promise<RunSnapshot> {
    const job = await this.ensureJob();
    if (refreshPage && !this.engineBusy) await this.refreshPage();

    const next = planNextAction(job);
    const startGuard = canStartRun(job);

    return {
      job,
      discoveredTeams: this.discoveredTeams,
      settings: this.settings,
      page: this.page,
      plan: {
        next,
        description: next ? describePlannedAction(job, next) : job.currentAction,
        remainingItems: remainingWorkCount(job),
      },
      requiredConfirmations: requiredConfirmations(job),
      missingConfirmations: missingConfirmations(job),
      startGuard: startGuard.allowed ? { allowed: true, reason: null } : { allowed: false, reason: startGuard.reason },
      recentLogs: this.recentLogs,
      engineBusy: this.engineBusy,
      selectorMapVersion: this.page.selectorMapVersion,
    };
  }

  private async refreshPage(): Promise<void> {
    try {
      const tab = await this.tabs.findCanvaTab();
      if (!tab || tab.id === undefined) {
        this.page = disconnectedPage();
        return;
      }
      if (tab.status !== 'complete') {
        this.page = { ...disconnectedPage(), detected: true, tabId: tab.id };
        return;
      }
      this.page = await this.tabs.detectPage(tab.id);
    } catch {
      this.page = disconnectedPage();
    }
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer !== null) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      void this.snapshot(false).then((snapshot) => {
        this.publish({ type: 'SNAPSHOT_UPDATED', snapshot });
      });
    }, SNAPSHOT_BROADCAST_DEBOUNCE_MS);
  }

  /* -------------------------------------------------------------- dispatch --- */

  private async dispatch(events: readonly RunEvent[]): Promise<void> {
    const job = this.job;
    if (!job) return;

    const now = new Date().toISOString();
    const result = reduceAll(job, events, { now });
    this.job = result.job;
    await this.store.saveRun(result.job);

    if (result.logs.length > 0) {
      const written = await this.logs.append(result.job.runId, result.logs, now);
      this.recentLogs = [...this.recentLogs, ...written].slice(-50);
    }

    this.scheduleBroadcast();
  }

  private async logSystem(level: LogEventDraft['level'], action: string, message: string, detail?: string): Promise<void> {
    const job = this.job;
    if (!job) return;
    const draft: LogEventDraft = {
      level,
      entityType: 'system',
      entityId: null,
      action,
      message,
      detail: detail ?? null,
      sourceTeamId: null,
      sourceTeamName: null,
      itemTitle: null,
      resultStatus: level === 'error' ? 'failure' : 'info',
      verificationLevel: null,
      errorCategory: null,
      screenshotRef: null,
    };
    const written = await this.logs.append(job.runId, [draft], new Date().toISOString());
    this.recentLogs = [...this.recentLogs, ...written].slice(-50);
  }

  private async logDebug(message: string, detail?: string): Promise<void> {
    if (!this.settings.debugMode) return;
    await this.logSystem('debug', 'debug', message, detail);
  }

  private async absorbDebug(lines: readonly string[]): Promise<void> {
    if (!this.settings.debugMode || lines.length === 0) return;
    await this.logSystem('debug', 'contentTrace', `${lines.length} step(s) traced`, lines.join('\n'));
  }

  /* ------------------------------------------------------------- settings --- */

  getSettings(): Settings {
    return this.settings;
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    this.settings = await this.store.saveSettings({ ...this.settings, ...patch });
    this.logs.setOptions({ maxEventsPerRun: this.settings.logRetentionMaxEvents });
    await this.logSystem('info', 'updateSettings', `Settings updated: ${Object.keys(patch).join(', ')}`);
    this.scheduleBroadcast();
    return this.settings;
  }

  async resetSettings(): Promise<Settings> {
    this.settings = await this.store.saveSettings({ ...DEFAULT_SETTINGS });
    await this.logSystem('warn', 'resetSettings', 'Settings restored to defaults');
    this.scheduleBroadcast();
    return this.settings;
  }

  async acceptDisclosure(): Promise<Settings> {
    return await this.updateSettings({ disclosureAcceptedAt: new Date().toISOString() });
  }

  /* ------------------------------------------------------------ discovery --- */

  async scanTeams(): Promise<CommandOutcome> {
    if (this.engineBusy) return fail('The engine is busy with another action.');
    await this.ensureJob();

    this.engineBusy = true;
    try {
      const tabId = await this.tabs.ensureCanvaTab(this.navigationTimeoutMs());
      const page = await this.tabs.detectPage(tabId);
      this.page = page;
      this.tabs.assertUsable(page);

      await this.dispatch([{ type: 'TEAM_DISCOVERY_STARTED' }]);

      const result = await this.tabs.send(
        tabId,
        { type: 'DISCOVER_TEAMS', options: this.actionOptions({ timeoutMs: this.settings.actionTimeoutMs }) },
        discoverTeamsResultSchema,
      );
      await this.absorbDebug(result.debug);

      this.discoveredTeams = result.data.teams;
      await this.dispatch([{ type: 'TEAMS_DISCOVERED', count: result.data.teams.length }]);
      await this.logSystem('info', 'discoverTeams', 'Workspace scan detail', result.data.detail);

      // Re-apply a saved default destination when it is still available.
      const preferred = this.settings.defaultDestinationTeamId;
      if (preferred) {
        const match = this.discoveredTeams.find((team) => team.internalId === preferred);
        if (match) await this.dispatch([{ type: 'DESTINATION_SELECTED', destination: createDestinationFromTeam(match) }]);
      }

      return OK;
    } catch (error) {
      const normalized = this.normalize(error, 'selector_not_found');
      await this.dispatch([{ type: 'TEAM_DISCOVERY_FAILED', error: normalized }]);
      return fail(normalized.message, normalized.category, normalized.nextStep);
    } finally {
      this.engineBusy = false;
      this.scheduleBroadcast();
    }
  }

  async selectTeams(teamIds: readonly string[]): Promise<CommandOutcome> {
    const teams = teamIds
      .map((id) => this.discoveredTeams.find((team) => team.internalId === id))
      .filter((team): team is Team => team !== undefined);

    if (teams.length !== teamIds.length) {
      return fail('Some selected workspaces are no longer in the scan results. Re-scan teams.');
    }
    await this.ensureJob();
    await this.dispatch([{ type: 'TEAMS_SELECTED', teams }]);
    return OK;
  }

  async selectDestination(teamId: string | null): Promise<CommandOutcome> {
    await this.ensureJob();
    if (teamId === null) {
      await this.dispatch([{ type: 'DESTINATION_SELECTED', destination: null }]);
      return OK;
    }
    const team = this.discoveredTeams.find((candidate) => candidate.internalId === teamId);
    if (!team) return fail('That destination is not in the scan results. Re-scan teams.', 'destination_not_found');

    await this.dispatch([{ type: 'DESTINATION_SELECTED', destination: createDestinationFromTeam(team) }]);
    await this.updateSettings({ defaultDestinationTeamId: teamId });
    return OK;
  }

  async selectMode(mode: ExecutionMode): Promise<CommandOutcome> {
    await this.ensureJob();
    if (mode !== 'dryRun' && !liveExecutionAllowed(this.settings)) {
      return fail(
        'Live execution is off for this browser profile. Accept the disclosure and enable live runs in Options first.',
        'unknown',
        'Open Options, read the disclosure, then switch live execution on.',
      );
    }
    await this.dispatch([{ type: 'MODE_SELECTED', mode }]);
    return OK;
  }

  async scanItems(): Promise<CommandOutcome> {
    if (this.engineBusy) return fail('The engine is busy with another action.');
    const job = await this.ensureJob();
    if (job.sourceTeams.length === 0) return fail('Select at least one source team first.');

    this.engineBusy = true;
    try {
      const tabId = await this.tabs.ensureCanvaTab(this.navigationTimeoutMs());

      for (const team of job.sourceTeams) {
        await this.dispatch([{ type: 'ITEM_DISCOVERY_STARTED', teamId: team.internalId }]);

        try {
          await this.tabs.ensureTeamProjects(tabId, team, {
            timeoutMs: this.navigationTimeoutMs(),
            expectedView: 'projects',
          });

          const result = await this.tabs.send(
            tabId,
            {
              type: 'DISCOVER_ITEMS',
              teamId: team.internalId,
              requireOwnedByMe: this.settings.requireOwnedByMe,
              options: this.actionOptions({ timeoutMs: this.settings.discoveryTimeoutMs }),
            },
            discoverItemsResultSchema,
          );
          await this.absorbDebug(result.debug);

          await this.dispatch([
            { type: 'ITEMS_DISCOVERED', teamId: team.internalId, items: result.data.items },
          ]);
          await this.logSystem(
            result.data.truncated ? 'warn' : 'info',
            'discoverItems',
            `Item scan detail for "${team.displayName}"`,
            result.data.detail,
          );

          await this.probeTeamItems(tabId, team.internalId);
        } catch (error) {
          const normalized = this.normalize(error, 'selector_not_found');
          await this.dispatch([{ type: 'ITEM_DISCOVERY_FAILED', teamId: team.internalId, error: normalized }]);
          if (isHaltingCategory(normalized.category)) {
            return fail(normalized.message, normalized.category, normalized.nextStep);
          }
        }

        await this.wait(actionDelay(this.settings));
      }

      await this.dispatch([{ type: 'DISCOVERY_COMPLETED' }]);
      return OK;
    } catch (error) {
      const normalized = this.normalize(error, 'unknown');
      await this.dispatch([{ type: 'PAUSE_REQUESTED', reason: normalized.message }]);
      return fail(normalized.message, normalized.category, normalized.nextStep);
    } finally {
      this.engineBusy = false;
      this.scheduleBroadcast();
    }
  }

  /**
   * FR-4 capability probing. Each probe opens one item menu, so it is capped per
   * team; items past the cap keep `copyActionUnknown` and say so in the review.
   */
  private async probeTeamItems(tabId: number, teamId: string): Promise<void> {
    const limit = this.settings.probeItemLimitPerTeam;
    if (limit <= 0) return;

    const job = this.job;
    if (!job) return;

    const candidates = itemsForTeam(job, teamId)
      .filter((item) => item.selected && item.copyCapability === 'unknown')
      .slice(0, limit);

    for (const item of candidates) {
      try {
        const result = await this.tabs.send(
          tabId,
          { type: 'PROBE_ITEM', item, options: this.actionOptions() },
          probeItemResultSchema,
        );
        await this.absorbDebug(result.debug);
        await this.dispatch([
          {
            type: 'ITEM_CAPABILITY_PROBED',
            itemId: item.internalId,
            capability: result.data.capability,
            detail: result.data.detail,
          },
        ]);
      } catch (error) {
        const normalized = this.normalize(error, 'selector_not_found');
        if (isHaltingCategory(normalized.category)) throw error;
        await this.dispatch([
          {
            type: 'ITEM_CAPABILITY_PROBED',
            itemId: item.internalId,
            capability: 'unknown',
            detail: `Probe failed: ${normalized.message}`,
          },
        ]);
      }
      await this.wait(actionDelay(this.settings));
    }
  }

  /* ---------------------------------------------------------------- review --- */

  async setItemInclusion(itemId: string, selected: boolean): Promise<CommandOutcome> {
    await this.ensureJob();
    await this.dispatch([{ type: 'ITEM_INCLUSION_SET', itemId, selected }]);
    return OK;
  }

  async setAllInclusions(selected: boolean, teamId: string | null): Promise<CommandOutcome> {
    const job = await this.ensureJob();
    const targets = job.items.filter((item) => teamId === null || item.sourceTeamId === teamId);
    await this.dispatch(
      targets.map((item) => ({ type: 'ITEM_INCLUSION_SET' as const, itemId: item.internalId, selected })),
    );
    return OK;
  }

  async grantConfirmation(scope: RunJob['confirmations']['scopes'][number]): Promise<CommandOutcome> {
    await this.ensureJob();
    if (scope === 'liveExecution' && !liveExecutionAllowed(this.settings)) {
      return fail('Enable live execution in Options before confirming a live run.');
    }
    await this.dispatch([{ type: 'CONFIRMATION_GRANTED', scope }]);
    return OK;
  }

  async revokeConfirmation(scope: RunJob['confirmations']['scopes'][number]): Promise<CommandOutcome> {
    await this.ensureJob();
    await this.dispatch([{ type: 'CONFIRMATION_REVOKED', scope }]);
    return OK;
  }

  async confirmLeave(teamId: string): Promise<CommandOutcome> {
    await this.ensureJob();
    await this.dispatch([{ type: 'LEAVE_CONFIRMED', teamId }]);
    void this.pump();
    return OK;
  }

  async skipLeave(teamId: string): Promise<CommandOutcome> {
    const job = await this.ensureJob();
    if (!findTeam(job, teamId)) return fail('That team is not part of this run.');
    await this.logSystem('warn', 'skipLeave', `Operator chose not to leave team ${teamId} during this run`);
    await this.dispatch([{ type: 'TEAM_COMPLETED', teamId }]);
    void this.pump();
    return OK;
  }

  async setOverrides(overrides: Partial<UserOverrides>): Promise<CommandOutcome> {
    await this.ensureJob();
    await this.dispatch([{ type: 'OVERRIDES_SET', overrides }]);
    return OK;
  }

  /* ------------------------------------------------------------- execution --- */

  async startRun(): Promise<CommandOutcome> {
    const job = await this.ensureJob();

    if (job.mode === 'dryRun') {
      return fail(
        'A dry run has no execution phase. Review the summary, then either finish the dry run or switch to a live mode.',
      );
    }
    if (!liveExecutionAllowed(this.settings)) {
      return fail(
        'Live execution is off for this browser profile.',
        'unknown',
        'Open Options, accept the disclosure, then enable live execution.',
      );
    }

    const guard = canStartRun(job);
    if (!guard.allowed) return fail(guard.reason, guard.category);

    await this.dispatch([{ type: 'START_REQUESTED' }]);
    void this.pump();
    return OK;
  }

  async pauseRun(): Promise<CommandOutcome> {
    await this.dispatch([{ type: 'PAUSE_REQUESTED', reason: 'Paused by operator' }]);
    return OK;
  }

  async resumeRun(): Promise<CommandOutcome> {
    const job = this.job;
    if (!job) return fail('There is no run to resume.');
    if (job.manualAssist) return fail('Resolve the pending manual step first.');
    await this.dispatch([{ type: 'RESUME_REQUESTED' }]);
    void this.pump();
    return OK;
  }

  async stopRun(): Promise<CommandOutcome> {
    await this.dispatch([{ type: 'STOP_REQUESTED' }]);
    await this.finalize();
    return OK;
  }

  async retryItem(itemId: string): Promise<CommandOutcome> {
    await this.dispatch([{ type: 'ITEM_RETRY_REQUESTED', itemId }]);
    void this.pump();
    return OK;
  }

  async skipItem(itemId: string, reason: string): Promise<CommandOutcome> {
    await this.dispatch([{ type: 'ITEM_SKIPPED', itemId, reason }]);
    void this.pump();
    return OK;
  }

  async resolveManualAssist(itemId: string, outcome: 'done' | 'skip'): Promise<CommandOutcome> {
    const tabId = this.tabs.getActiveTabId();
    if (tabId !== null) {
      try {
        await this.tabs.send(tabId, { type: 'CLEAR_HIGHLIGHT' }, simpleActionResultSchema);
      } catch {
        // Clearing the highlight is best-effort.
      }
    }
    await this.dispatch([{ type: 'MANUAL_ASSIST_RESOLVED', itemId, outcome }]);
    void this.pump();
    return OK;
  }

  async newRun(): Promise<CommandOutcome> {
    if (this.engineBusy || this.loopRunning) return fail('Stop the current run before starting a new one.');
    const job = createRunJob({
      mode: this.settings.defaultMode,
      now: new Date().toISOString(),
      settings: this.settings,
      selectorMapVersion: this.page.selectorMapVersion,
    });
    this.job = job;
    this.recentLogs = [];
    await this.store.saveRun(job);
    await this.logSystem('info', 'newRun', `New run created in mode "${EXECUTION_MODE_LABELS[job.mode]}"`);
    this.scheduleBroadcast();
    return OK;
  }

  /* ------------------------------------------------------------- the loop --- */

  /** Drives planned actions until the run needs the operator or finishes. */
  private async pump(): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    this.keepAlive.start();

    try {
      for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration += 1) {
        const job = this.job;
        if (!job) break;

        if (job.consecutiveFailures >= this.settings.circuitBreakerThreshold) {
          await this.dispatch([
            {
              type: 'PAUSE_REQUESTED',
              reason: `${job.consecutiveFailures} failures in a row. Paused so the cause can be checked before continuing.`,
            },
          ]);
          break;
        }

        const action = planNextAction(job);
        if (!action) break;

        this.engineBusy = true;
        let verdict: 'continue' | 'stop';
        try {
          verdict = await this.executeAction(action);
        } catch (error) {
          const normalized = this.normalize(error, 'unknown');
          if (isHaltingCategory(normalized.category)) {
            await this.dispatch([{ type: 'RUN_BLOCKED', error: normalized }]);
            this.publish({
              type: 'RUN_ATTENTION',
              message: normalized.message,
              category: normalized.category,
            });
          } else {
            await this.dispatch([{ type: 'PAUSE_REQUESTED', reason: normalized.message }]);
          }
          verdict = 'stop';
        } finally {
          this.engineBusy = false;
        }

        if (verdict === 'stop') break;

        const current = this.job;
        if (current) await this.wait(actionDelay(this.settings) + streakDelay(this.settings, current.consecutiveFailures));
      }
    } finally {
      this.loopRunning = false;
      this.keepAlive.stop();
      this.scheduleBroadcast();
    }
  }

  private async executeAction(action: PlannedAction): Promise<'continue' | 'stop'> {
    const job = this.job;
    if (!job) return 'stop';

    switch (action.kind) {
      case 'startTeam': {
        const team = findTeam(job, action.teamId);
        if (!team) {
          await this.dispatch([{ type: 'TEAM_COMPLETED', teamId: action.teamId }]);
          return 'continue';
        }
        const tabId = await this.requireTab();
        await this.dispatch([{ type: 'CURRENT_ACTION_SET', text: `Switching to "${team.displayName}"` }]);
        await this.tabs.ensureTeamProjects(tabId, team, {
          timeoutMs: this.navigationTimeoutMs(),
          expectedView: 'projects',
        });
        await this.dispatch([{ type: 'TEAM_STARTED', teamId: team.internalId }]);
        return 'continue';
      }

      case 'copyItem':
        return await this.runCopy(action.itemId);

      case 'verifyItem':
        return await this.runVerify(action.itemId);

      case 'trashItem':
        return await this.runTrash(action.itemId);

      case 'teamItemsExhausted': {
        await this.dispatch([{ type: 'TEAM_ITEMS_EXHAUSTED', teamId: action.teamId }]);
        return 'continue';
      }

      case 'awaitLeaveConfirmation': {
        const team = findTeam(job, action.teamId);
        await this.dispatch([
          {
            type: 'CURRENT_ACTION_SET',
            text: `Waiting for your confirmation to leave "${team?.displayName ?? action.teamId}"`,
          },
        ]);
        return 'stop';
      }

      case 'leaveTeam':
        return await this.runLeave(action.teamId);

      case 'completeTeam': {
        await this.dispatch([{ type: 'TEAM_COMPLETED', teamId: action.teamId }]);
        const current = this.job;
        if (current && this.settings.pauseBetweenTeams && current.teamQueue.length > 0) {
          await this.dispatch([
            { type: 'PAUSE_REQUESTED', reason: 'Paused between teams. Resume when you are ready for the next one.' },
          ]);
          return 'stop';
        }
        return 'continue';
      }

      case 'finishRun': {
        await this.dispatch([{ type: 'RUN_FINISHED' }]);
        await this.finalize();
        return 'stop';
      }

      default: {
        const exhaustive: never = action;
        await this.logSystem('error', 'plan', `Unhandled planned action: ${JSON.stringify(exhaustive)}`);
        return 'stop';
      }
    }
  }

  /* --------------------------------------------------------------- steps --- */

  private async runCopy(itemId: string): Promise<'continue' | 'stop'> {
    const job = this.job;
    if (!job) return 'stop';
    const item = findItem(job, itemId);
    if (!item) return 'stop';

    const destination = job.destination;
    if (!destination) {
      await this.dispatch([{ type: 'PAUSE_REQUESTED', reason: 'No copy destination is selected.' }]);
      return 'stop';
    }
    const team = findTeam(job, item.sourceTeamId);
    if (!team) {
      await this.dispatch([{ type: 'ITEM_SKIPPED', itemId, reason: 'Source team is no longer part of this run' }]);
      return 'continue';
    }

    const tabId = await this.requireTab();
    await this.tabs.ensureTeamProjects(tabId, team, {
      timeoutMs: this.navigationTimeoutMs(),
      expectedView: 'projects',
    });

    await this.dispatch([{ type: 'COPY_STARTED', itemId }]);

    try {
      const result = await this.withRetries('copyItem', 'copy_action_missing', async () => {
        const response = await this.tabs.send(
          tabId,
          { type: 'COPY_ITEM', item, destination, options: this.actionOptions() },
          copyItemResultSchema,
        );
        await this.absorbDebug(response.debug);
        return response.data;
      });

      await this.dispatch([
        {
          type: 'COPY_SUCCEEDED',
          itemId,
          detail: result.detail,
          sawConfirmation: result.sawSuccessConfirmation,
        },
      ]);
    } catch (error) {
      await this.handleStepFailure('copy', item, error);
    }
    return 'continue';
  }

  private async runVerify(itemId: string): Promise<'continue' | 'stop'> {
    const job = this.job;
    if (!job) return 'stop';
    const item = findItem(job, itemId);
    if (!item) return 'stop';

    await this.dispatch([{ type: 'VERIFY_STARTED', itemId }]);

    // Strongest evidence: Canva confirmed the copy while it happened.
    if (item.copyConfirmationSeen) {
      await this.dispatch([
        {
          type: 'VERIFY_SUCCEEDED',
          itemId,
          level: 'strong',
          detail: 'Canva showed an explicit success confirmation during the copy',
        },
      ]);
      return 'continue';
    }

    const destination = job.destination;
    const team = findTeam(job, item.sourceTeamId);
    if (!destination || !team) {
      await this.dispatch([
        {
          type: 'VERIFY_FAILED',
          itemId,
          error: normalizeError({
            category: 'destination_not_found',
            detail: 'Destination or source team missing while verifying',
          }),
        },
      ]);
      return 'continue';
    }

    const tabId = await this.requireTab();
    try {
      await this.tabs.ensureDestinationProjects(tabId, destination, { timeoutMs: this.navigationTimeoutMs() });

      const result = await this.withRetries('verifyCopy', 'copy_verification_failed', async () => {
        const response = await this.tabs.send(
          tabId,
          { type: 'VERIFY_COPY', item, destination, options: this.actionOptions() },
          verifyCopyResultSchema,
        );
        await this.absorbDebug(response.debug);
        return response.data;
      });

      await this.dispatch([
        { type: 'VERIFY_SUCCEEDED', itemId, level: result.level, detail: result.detail },
      ]);
    } catch (error) {
      await this.handleStepFailure('verify', item, error);
    } finally {
      // Return to the source listing so the next step starts from a known view.
      try {
        await this.tabs.ensureTeamProjects(tabId, team, {
          timeoutMs: this.navigationTimeoutMs(),
          expectedView: 'projects',
        });
      } catch (error) {
        await this.logDebug('Could not return to the source listing after verification', String(error));
      }
    }
    return 'continue';
  }

  private async runTrash(itemId: string): Promise<'continue' | 'stop'> {
    const job = this.job;
    if (!job) return 'stop';
    const item = findItem(job, itemId);
    if (!item) return 'stop';
    const team = findTeam(job, item.sourceTeamId);
    if (!team) return 'stop';

    const tabId = await this.requireTab();
    await this.tabs.ensureTeamProjects(tabId, team, {
      timeoutMs: this.navigationTimeoutMs(),
      expectedView: 'projects',
    });

    await this.dispatch([{ type: 'TRASH_STARTED', itemId }]);

    // The reducer refuses unverified trashing; if it parked the item, stop here.
    const afterGuard = this.job ? findItem(this.job, itemId) : undefined;
    if (afterGuard && afterGuard.state === 'manualReviewRequired') return 'continue';

    try {
      const result = await this.withRetries('trashItem', 'delete_action_missing', async () => {
        const response = await this.tabs.send(
          tabId,
          { type: 'TRASH_ITEM', item, options: this.actionOptions() },
          simpleActionResultSchema,
        );
        await this.absorbDebug(response.debug);
        return response.data;
      });

      await this.dispatch([{ type: 'TRASH_SUCCEEDED', itemId, detail: result.detail }]);
    } catch (error) {
      await this.handleStepFailure('trash', item, error);
    }
    return 'continue';
  }

  private async runLeave(teamId: string): Promise<'continue' | 'stop'> {
    const job = this.job;
    if (!job) return 'stop';
    const team = findTeam(job, teamId);
    if (!team) return 'stop';

    const tabId = await this.requireTab();
    await this.dispatch([{ type: 'LEAVE_STARTED', teamId }]);

    try {
      // Leaving acts on the active workspace, so switch into it first.
      await this.tabs.ensureTeamProjects(tabId, team, {
        timeoutMs: this.navigationTimeoutMs(),
        expectedView: 'projects',
      });
    } catch (error) {
      await this.logDebug('Could not switch into the team before leaving', String(error));
    }

    let lastError: NormalizedError | null = null;

    for (const url of this.tabs.teamSettingsUrls()) {
      try {
        await this.tabs.navigate(tabId, url, { timeoutMs: this.navigationTimeoutMs() });

        const outcome = await this.tabs.sendTolerateNavigation(
          tabId,
          { type: 'LEAVE_TEAM', team, options: this.actionOptions() },
          simpleActionResultSchema,
        );

        if (outcome.kind === 'navigated') {
          const gone = await this.confirmTeamGone(tabId, team);
          if (gone) {
            await this.dispatch([{ type: 'LEAVE_SUCCEEDED', teamId }]);
            await this.dispatch([{ type: 'TEAM_COMPLETED', teamId }]);
            return 'continue';
          }
          lastError = normalizeError({
            category: 'unexpected_navigation',
            message: 'The page navigated during the leave step and the team is still listed',
            detail: outcome.detail,
          });
          continue;
        }

        await this.absorbDebug(outcome.debug);
        await this.dispatch([{ type: 'LEAVE_SUCCEEDED', teamId }]);
        await this.dispatch([{ type: 'TEAM_COMPLETED', teamId }]);
        return 'continue';
      } catch (error) {
        const normalized = this.normalize(error, 'selector_not_found');
        lastError = normalized;
        if (isHaltingCategory(normalized.category)) {
          await this.dispatch([{ type: 'LEAVE_FAILED', teamId, error: normalized }]);
          throw error;
        }
        await this.logDebug(`Leave attempt on ${url} failed: ${normalized.message}`, normalized.detail ?? undefined);
      }
    }

    await this.dispatch([
      {
        type: 'LEAVE_FAILED',
        teamId,
        error:
          lastError ??
          normalizeError({ category: 'selector_not_found', detail: 'No leave control was found on any settings page' }),
      },
    ]);
    return 'stop';
  }

  /** Verifies a leave by re-reading Canva's own workspace switcher. */
  private async confirmTeamGone(tabId: number, team: Team): Promise<boolean> {
    try {
      await this.tabs.waitForContentReady(tabId, this.navigationTimeoutMs());
      const result = await this.tabs.send(
        tabId,
        { type: 'DISCOVER_TEAMS', options: this.actionOptions() },
        discoverTeamsResultSchema,
      );
      await this.absorbDebug(result.debug);
      const stillThere = result.data.teams.some(
        (candidate) =>
          candidate.internalId === team.internalId ||
          candidate.displayName.trim().toLowerCase() === team.displayName.trim().toLowerCase(),
      );
      return !stillThere;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------ failure handling --- */

  private async handleStepFailure(step: StepKind, item: DesignItem, error: unknown): Promise<void> {
    const normalized = this.normalize(error, step === 'copy' ? 'copy_action_missing' : 'unknown');

    if (isHaltingCategory(normalized.category)) {
      // Record the step failure before halting, so the item's state reflects
      // what actually happened. Leaving it mid-step would mean a later resume
      // silently retried an action whose outcome nobody has checked.
      await this.recordStepFailure(step, item.internalId, normalized);
      await this.dispatch([{ type: 'RUN_BLOCKED', error: normalized }]);
      this.publish({ type: 'RUN_ATTENTION', message: normalized.message, category: normalized.category });
      return;
    }

    if (this.settings.manualAssistEnabled && MANUAL_ASSIST_CATEGORIES.has(normalized.category)) {
      await this.requestManualAssist(step, item, normalized);
      return;
    }

    if (normalized.resolution === 'pause' || normalized.escalation === 'pause') {
      await this.recordStepFailure(step, item.internalId, normalized);
      await this.dispatch([{ type: 'PAUSE_REQUESTED', reason: normalized.message }]);
      return;
    }

    await this.recordStepFailure(step, item.internalId, normalized);
  }

  private async recordStepFailure(step: StepKind, itemId: string, error: NormalizedError): Promise<void> {
    if (step === 'copy') await this.dispatch([{ type: 'COPY_FAILED', itemId, error }]);
    else if (step === 'verify') await this.dispatch([{ type: 'VERIFY_FAILED', itemId, error }]);
    else await this.dispatch([{ type: 'TRASH_FAILED', itemId, error }]);
  }

  /** FR-14: hand the step to the operator instead of guessing. */
  private async requestManualAssist(step: StepKind, item: DesignItem, error: NormalizedError): Promise<void> {
    const job = this.job;
    const destinationName = job?.destination?.displayName ?? 'the destination';
    const instruction =
      step === 'copy'
        ? `Copy "${item.title}" to ${destinationName} yourself using Canva's copy action.`
        : step === 'verify'
          ? `Check ${destinationName} and confirm that "${item.title}" is there.`
          : `Move the original of "${item.title}" to trash yourself.`;

    const tabId = this.tabs.getActiveTabId();
    if (tabId !== null) {
      try {
        await this.tabs.send(
          tabId,
          { type: 'HIGHLIGHT_ITEM', item, instruction, options: this.actionOptions() },
          highlightResultSchema,
        );
      } catch {
        // Highlighting is a nicety; the instruction still reaches the popup.
      }
    }

    await this.logSystem(
      'warn',
      'manualAssist',
      `Automation stalled on "${item.title}" (${error.category}); asking for a manual step`,
      error.detail ?? undefined,
    );
    await this.dispatch([{ type: 'MANUAL_ASSIST_REQUESTED', itemId: item.internalId, step, instruction }]);
    this.publish({ type: 'RUN_ATTENTION', message: instruction, category: error.category });
  }

  private async withRetries<T>(
    label: string,
    fallbackCategory: ErrorCategory,
    operation: () => Promise<T>,
  ): Promise<T> {
    const maxAttempts = this.settings.maxRetriesPerAction + 1;
    let last: NormalizedError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const normalized = this.normalize(error, fallbackCategory);
        last = normalized;

        if (isHaltingCategory(normalized.category) || !normalized.retryable || attempt === maxAttempts) {
          throw new ContentActionFailure(normalized);
        }
        await this.logDebug(
          `${label} attempt ${attempt}/${maxAttempts} failed (${normalized.category}); backing off`,
          normalized.detail ?? undefined,
        );
        await this.wait(retryDelay(this.settings, attempt));
      }
    }

    throw new ContentActionFailure(last ?? normalizeError({ category: fallbackCategory }));
  }

  private normalize(error: unknown, fallbackCategory: ErrorCategory): NormalizedError {
    if (error instanceof ContentActionFailure) return error.normalized;
    return toNormalizedError(error, fallbackCategory);
  }

  /* ---------------------------------------------------------------- utils --- */

  private async requireTab(): Promise<number> {
    return await this.tabs.ensureCanvaTab(this.navigationTimeoutMs());
  }

  private navigationTimeoutMs(): number {
    return Math.max(20_000, this.settings.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS);
  }

  private actionOptions(overrides: Partial<ActionOptions> = {}): ActionOptions {
    return {
      timeoutMs: this.settings.actionTimeoutMs,
      stepDelayMs: this.settings.actionDelayMs,
      stepJitterMs: this.settings.actionJitterMs,
      debug: this.settings.debugMode,
      dryRun: this.job?.mode === 'dryRun',
      ...overrides,
    };
  }

  private async finalize(): Promise<void> {
    const job = this.job;
    if (!job) return;
    await this.store.saveReport(buildRunReport(job));
    this.keepAlive.stop();
    this.scheduleBroadcast();
  }

  /* ----------------------------------------------------------------- data --- */

  async getLogs(runId?: string): Promise<LogEvent[]> {
    const target = runId ?? this.job?.runId;
    if (!target) return [];
    return await this.logs.read(target);
  }

  async purgeLocalData(): Promise<CommandOutcome> {
    if (this.loopRunning || this.engineBusy) return fail('Stop the current run before purging local data.');
    const runIds = await this.logs.listRunIds();
    await this.logs.purgeAll();
    await this.store.purgeAll(runIds);
    this.job = null;
    this.discoveredTeams = [];
    this.recentLogs = [];
    this.settings = DEFAULT_SETTINGS;
    await this.ensureJob();
    this.scheduleBroadcast();
    return OK;
  }
}
