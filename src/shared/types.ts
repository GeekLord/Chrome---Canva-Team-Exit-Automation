/**
 * Canonical domain entities: `Team`, `DesignItem`, `RunJob`, `LogEvent`.
 *
 * Anything new the extension needs to track belongs on one of these four types.
 * Parallel shapes for the same concept are not allowed.
 */

import type { EXECUTION_MODES } from './constants';
import type { ErrorCategory, NormalizedError } from './errors';

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/* ------------------------------------------------------------------ Team --- */

export type LeaveSupportState = 'unknown' | 'available' | 'blockedByPolicy' | 'notApplicable';

export interface Team {
  /** Stable-ish id derived from the Canva workspace URL, or a hash of the name. */
  internalId: string;
  displayName: string;
  workspaceUrl: string | null;
  leaveSupportedState: LeaveSupportState;
  discoveryTimestamp: string;
  /** True for the workspace the session was in when discovery ran. */
  isCurrent: boolean;
  /** True when Canva labels this as the user's personal workspace. */
  isPersonal: boolean;
}

/* ------------------------------------------------------------ DesignItem --- */

export type ItemType = 'design' | 'folder' | 'file' | 'unknown';

export type OwnerConfidence = 'high' | 'medium' | 'low' | 'unknown';

/** Result of the non-mutating capability probe used by dry runs. */
export type CopyCapability = 'available' | 'unavailable' | 'unknown';

export type RiskFlag =
  | 'ownershipUnclear'
  | 'copyActionUnknown'
  | 'copyActionMissing'
  | 'sharedWithTeam'
  | 'itemTypeUnsupported'
  | 'duplicateTitleInDestination'
  | 'titleEmpty';

/** Item-level state machine, per the spec. */
export type ItemState =
  | 'discovered'
  | 'selected'
  | 'copyPending'
  | 'copyInProgress'
  /** Copy landed but verification has not run yet. */
  | 'copied'
  | 'copyFailed'
  | 'copyVerified'
  | 'deletePending'
  | 'deleteInProgress'
  | 'deleteFailed'
  | 'completed'
  | 'skipped'
  | 'manualReviewRequired';

export type CopyStatus = 'pending' | 'inProgress' | 'copied' | 'failed' | 'skipped' | 'unknown';

/** Verification strength is first-class: strong, weak or manual. */
export type VerificationStatus = 'unverified' | 'strong' | 'weak' | 'manual' | 'failed';

export type DeleteStatus = 'notRequested' | 'pending' | 'inProgress' | 'trashed' | 'failed' | 'blocked';

export interface ItemAttemptCounters {
  copy: number;
  verify: number;
  trash: number;
}

export interface DesignItem {
  internalId: string;
  title: string;
  sourceUrl: string | null;
  sourceTeamId: string;
  folderPath: string | null;
  itemType: ItemType;
  ownerLabel: string | null;
  ownerConfidence: OwnerConfidence;
  discoveredAt: string;
  selected: boolean;
  state: ItemState;
  copyStatus: CopyStatus;
  verificationStatus: VerificationStatus;
  deleteStatus: DeleteStatus;
  copyCapability: CopyCapability;
  /**
   * True when Canva showed an explicit success confirmation while the copy ran.
   * Persisted because it is the strongest verification signal available and it
   * must survive the gap between the copy step and the verify step.
   */
  copyConfirmationSeen: boolean;
  riskFlags: RiskFlag[];
  attempts: ItemAttemptCounters;
  lastError: NormalizedError | null;
  /** Free-form audit breadcrumbs, newest last. */
  notes: string[];
}

/* --------------------------------------------------------------- RunJob --- */

export type DestinationKind = 'sameLoginWorkspace' | 'separateAccountShareCopy';

export interface Destination {
  kind: DestinationKind;
  /** Team/workspace id for `sameLoginWorkspace`. Null for the deferred mode. */
  teamId: string | null;
  displayName: string;
  workspaceUrl: string | null;
}

/** Top-level run state machine, per the spec. */
export type RunState =
  | 'idle'
  | 'discoveringTeams'
  | 'selectingTeams'
  | 'discoveringItems'
  | 'reviewReady'
  | 'awaitingStartConfirmation'
  | 'copying'
  | 'verifying'
  | 'trashing'
  | 'awaitingLeaveConfirmation'
  | 'leavingTeam'
  | 'paused'
  | 'completed'
  | 'completedWithWarnings'
  | 'failed'
  | 'blocked';

export interface RunCounters {
  teamsSelected: number;
  teamsProcessed: number;
  teamsLeft: number;
  itemsFound: number;
  itemsSelected: number;
  copied: number;
  verified: number;
  trashed: number;
  failed: number;
  skipped: number;
  manualReview: number;
}

/** Explicit, opt-in relaxations of the default safety rules. */
export interface UserOverrides {
  /** Allows trashing an item whose copy could not be verified. Off by default. */
  allowTrashWithoutVerification: boolean;
  /** Allows leaving a team while some selected items are unresolved. Off by default. */
  allowLeaveWithUnresolvedItems: boolean;
}

export type ConfirmationScope = 'liveExecution' | 'trash' | 'leaveTeam' | 'multiTeamBatch' | 'largeBatch';

export interface ConfirmationLedger {
  scopes: ConfirmationScope[];
  /** Leaving is confirmed per team, right before the leave step. */
  leaveConfirmedTeamIds: string[];
}

/**
 * Settings snapshot taken when the run is created.
 *
 * The reducer only ever reads safety-relevant values from here so a resumed run
 * cannot silently become less safe than the one the user reviewed. Pacing and
 * retry limits are read live from settings by the coordinator, so an operator
 * can slow a run down mid-flight.
 */
export interface RunSettingsSnapshot {
  confirmationItemThreshold: number;
  requireOwnedByMe: boolean;
  selectorMapVersion: string;
}

export interface RunJob {
  runId: string;
  mode: ExecutionMode;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  sourceTeams: Team[];
  destination: Destination | null;
  counters: RunCounters;
  state: RunState;
  userOverrides: UserOverrides;
  settings: RunSettingsSnapshot;

  /* Orchestration bookkeeping. */
  items: DesignItem[];
  /** Source team ids still to process, in order. */
  teamQueue: string[];
  /** Source team ids whose item queue has been fully worked through. */
  processedTeamIds: string[];
  /** Source team ids the user has actually left during this run. */
  leftTeamIds: string[];
  activeTeamId: string | null;
  activeItemId: string | null;
  /** Human-readable "what am I doing right now" text for the popup. */
  currentAction: string | null;
  confirmations: ConfirmationLedger;
  /** Set when state is `paused`. */
  pauseReason: string | null;
  /** Set when state is `blocked` or `failed`. */
  blocker: NormalizedError | null;
  /** Failures in a row across items; drives the circuit breaker. */
  consecutiveFailures: number;
  /** Item id awaiting a manual-assist confirmation, if any. */
  manualAssist: ManualAssistRequest | null;
  updatedAt: string;
}

export interface ManualAssistRequest {
  itemId: string;
  step: 'copy' | 'verify' | 'trash';
  instruction: string;
  raisedAt: string;
}

/* ------------------------------------------------------------- LogEvent --- */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntityType = 'run' | 'team' | 'item' | 'system';

export type LogResultStatus = 'started' | 'success' | 'failure' | 'skipped' | 'blocked' | 'info';

export interface LogEvent {
  eventId: string;
  runId: string;
  timestamp: string;
  level: LogLevel;
  entityType: LogEntityType;
  entityId: string | null;
  action: string;
  message: string;
  detail: string | null;
  sourceTeamId: string | null;
  sourceTeamName: string | null;
  itemTitle: string | null;
  resultStatus: LogResultStatus;
  verificationLevel: VerificationStatus | null;
  errorCategory: ErrorCategory | null;
  screenshotRef: string | null;
}

/** What the reducer and executors emit; the log store stamps id/run/time. */
export type LogEventDraft = Omit<LogEvent, 'eventId' | 'runId' | 'timestamp'>;

/* ------------------------------------------------------------- Settings --- */

export interface Settings {
  version: number;
  /** Live execution must be switched on deliberately, per browser profile. */
  liveExecutionEnabled: boolean;
  /** Set once the user accepts the in-product disclosure. */
  disclosureAcceptedAt: string | null;
  defaultMode: ExecutionMode;
  defaultDestinationTeamId: string | null;
  /** Base delay between Canva actions, before jitter. */
  actionDelayMs: number;
  /** Random extra delay in [0, jitterMs). */
  actionJitterMs: number;
  actionTimeoutMs: number;
  discoveryTimeoutMs: number;
  maxRetriesPerAction: number;
  backoffMultiplier: number;
  circuitBreakerThreshold: number;
  /** Runs larger than this need an extra confirmation. */
  confirmationItemThreshold: number;
  /** Restrict discovery to items Canva attributes to the current user. */
  requireOwnedByMe: boolean;
  /** Pause between teams in a multi-team batch. */
  pauseBetweenTeams: boolean;
  /**
   * Capability probing opens each item's own menu, so it is capped per team.
   * Items past the cap stay `unknown` rather than being probed.
   */
  probeItemLimitPerTeam: number;
  /** Offer a manual step instead of failing outright when automation stalls. */
  manualAssistEnabled: boolean;
  debugMode: boolean;
  overrides: UserOverrides;
  logRetentionMaxEvents: number;
}
