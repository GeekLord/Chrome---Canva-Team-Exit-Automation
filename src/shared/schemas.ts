/**
 * Runtime validation at every boundary: `chrome.storage` reads, messages
 * crossing the popup / background / content-script gap, and imported settings.
 *
 * The `_*Assignable` / `_*Covers` exported types are compile-time assertions
 * that each schema stays structurally identical to its hand-written TypeScript
 * counterpart in `types.ts`. If the two drift, `tsc` fails.
 */

import { z } from 'zod';

import { EXECUTION_MODES } from './constants';
import { ERROR_CATEGORIES } from './errors';
import type { DesignItem, LogEvent, RunJob, Settings, Team } from './types';

type AssertAssignable<A extends B, B> = A;

/* --------------------------------------------------------------- Errors --- */

export const errorCategorySchema = z.enum(ERROR_CATEGORIES);

export const errorResolutionSchema = z.enum(['retry', 'skip', 'pause', 'block']);

export const normalizedErrorSchema = z.object({
  category: errorCategorySchema,
  message: z.string(),
  detail: z.string().nullable(),
  explanation: z.string(),
  nextStep: z.string(),
  resolution: errorResolutionSchema,
  escalation: z.enum(['skip', 'pause', 'block']),
  retryable: z.boolean(),
});

/* ----------------------------------------------------------------- Team --- */

export const leaveSupportStateSchema = z.enum(['unknown', 'available', 'blockedByPolicy', 'notApplicable']);

export const teamSchema = z.object({
  internalId: z.string().min(1),
  displayName: z.string(),
  workspaceUrl: z.string().nullable(),
  leaveSupportedState: leaveSupportStateSchema,
  discoveryTimestamp: z.string(),
  isCurrent: z.boolean(),
  isPersonal: z.boolean(),
});

export type _TeamAssignable = AssertAssignable<z.infer<typeof teamSchema>, Team>;
export type _TeamCovers = AssertAssignable<Team, z.infer<typeof teamSchema>>;

/* ----------------------------------------------------------- DesignItem --- */

export const itemTypeSchema = z.enum(['design', 'folder', 'file', 'unknown']);
export const ownerConfidenceSchema = z.enum(['high', 'medium', 'low', 'unknown']);
export const copyCapabilitySchema = z.enum(['available', 'unavailable', 'unknown']);

export const riskFlagSchema = z.enum([
  'ownershipUnclear',
  'copyActionUnknown',
  'copyActionMissing',
  'sharedWithTeam',
  'itemTypeUnsupported',
  'duplicateTitleInDestination',
  'titleEmpty',
]);

export const itemStateSchema = z.enum([
  'discovered',
  'selected',
  'copyPending',
  'copyInProgress',
  'copied',
  'copyFailed',
  'copyVerified',
  'deletePending',
  'deleteInProgress',
  'deleteFailed',
  'completed',
  'skipped',
  'manualReviewRequired',
]);

export const copyStatusSchema = z.enum(['pending', 'inProgress', 'copied', 'failed', 'skipped', 'unknown']);
export const verificationStatusSchema = z.enum(['unverified', 'strong', 'weak', 'manual', 'failed']);
export const deleteStatusSchema = z.enum(['notRequested', 'pending', 'inProgress', 'trashed', 'failed', 'blocked']);

export const designItemSchema = z.object({
  internalId: z.string().min(1),
  title: z.string(),
  sourceUrl: z.string().nullable(),
  sourceTeamId: z.string(),
  folderPath: z.string().nullable(),
  itemType: itemTypeSchema,
  ownerLabel: z.string().nullable(),
  ownerConfidence: ownerConfidenceSchema,
  discoveredAt: z.string(),
  selected: z.boolean(),
  state: itemStateSchema,
  copyStatus: copyStatusSchema,
  verificationStatus: verificationStatusSchema,
  deleteStatus: deleteStatusSchema,
  copyCapability: copyCapabilitySchema,
  copyConfirmationSeen: z.boolean(),
  riskFlags: z.array(riskFlagSchema),
  attempts: z.object({ copy: z.number().int().min(0), verify: z.number().int().min(0), trash: z.number().int().min(0) }),
  lastError: normalizedErrorSchema.nullable(),
  notes: z.array(z.string()),
});

export type _DesignItemAssignable = AssertAssignable<z.infer<typeof designItemSchema>, DesignItem>;
export type _DesignItemCovers = AssertAssignable<DesignItem, z.infer<typeof designItemSchema>>;

/* --------------------------------------------------------------- RunJob --- */

export const executionModeSchema = z.enum(EXECUTION_MODES);

export const destinationSchema = z.object({
  kind: z.enum(['sameLoginWorkspace', 'separateAccountShareCopy']),
  teamId: z.string().nullable(),
  displayName: z.string(),
  workspaceUrl: z.string().nullable(),
});

export const runStateSchema = z.enum([
  'idle',
  'discoveringTeams',
  'selectingTeams',
  'discoveringItems',
  'reviewReady',
  'awaitingStartConfirmation',
  'copying',
  'verifying',
  'trashing',
  'awaitingLeaveConfirmation',
  'leavingTeam',
  'paused',
  'completed',
  'completedWithWarnings',
  'failed',
  'blocked',
]);

export const runCountersSchema = z.object({
  teamsSelected: z.number().int().min(0),
  teamsProcessed: z.number().int().min(0),
  teamsLeft: z.number().int().min(0),
  itemsFound: z.number().int().min(0),
  itemsSelected: z.number().int().min(0),
  copied: z.number().int().min(0),
  verified: z.number().int().min(0),
  trashed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  manualReview: z.number().int().min(0),
});

export const userOverridesSchema = z.object({
  allowTrashWithoutVerification: z.boolean(),
  allowLeaveWithUnresolvedItems: z.boolean(),
});

export const confirmationScopeSchema = z.enum(['liveExecution', 'trash', 'leaveTeam', 'multiTeamBatch', 'largeBatch']);

export const confirmationLedgerSchema = z.object({
  scopes: z.array(confirmationScopeSchema),
  leaveConfirmedTeamIds: z.array(z.string()),
});

export const runSettingsSnapshotSchema = z.object({
  confirmationItemThreshold: z.number().int().min(1),
  requireOwnedByMe: z.boolean(),
  selectorMapVersion: z.string(),
});

export const manualAssistRequestSchema = z.object({
  itemId: z.string(),
  step: z.enum(['copy', 'verify', 'trash']),
  instruction: z.string(),
  raisedAt: z.string(),
});

export const runJobSchema = z.object({
  runId: z.string().min(1),
  mode: executionModeSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  sourceTeams: z.array(teamSchema),
  destination: destinationSchema.nullable(),
  counters: runCountersSchema,
  state: runStateSchema,
  userOverrides: userOverridesSchema,
  settings: runSettingsSnapshotSchema,
  items: z.array(designItemSchema),
  teamQueue: z.array(z.string()),
  processedTeamIds: z.array(z.string()),
  leftTeamIds: z.array(z.string()),
  activeTeamId: z.string().nullable(),
  activeItemId: z.string().nullable(),
  currentAction: z.string().nullable(),
  confirmations: confirmationLedgerSchema,
  pauseReason: z.string().nullable(),
  blocker: normalizedErrorSchema.nullable(),
  consecutiveFailures: z.number().int().min(0),
  manualAssist: manualAssistRequestSchema.nullable(),
  updatedAt: z.string(),
});

export type _RunJobAssignable = AssertAssignable<z.infer<typeof runJobSchema>, RunJob>;
export type _RunJobCovers = AssertAssignable<RunJob, z.infer<typeof runJobSchema>>;

/* ------------------------------------------------------------- LogEvent --- */

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export const logEntityTypeSchema = z.enum(['run', 'team', 'item', 'system']);
export const logResultStatusSchema = z.enum(['started', 'success', 'failure', 'skipped', 'blocked', 'info']);

export const logEventSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  timestamp: z.string(),
  level: logLevelSchema,
  entityType: logEntityTypeSchema,
  entityId: z.string().nullable(),
  action: z.string(),
  message: z.string(),
  detail: z.string().nullable(),
  sourceTeamId: z.string().nullable(),
  sourceTeamName: z.string().nullable(),
  itemTitle: z.string().nullable(),
  resultStatus: logResultStatusSchema,
  verificationLevel: verificationStatusSchema.nullable(),
  errorCategory: errorCategorySchema.nullable(),
  screenshotRef: z.string().nullable(),
});

export type _LogEventAssignable = AssertAssignable<z.infer<typeof logEventSchema>, LogEvent>;
export type _LogEventCovers = AssertAssignable<LogEvent, z.infer<typeof logEventSchema>>;

/* ------------------------------------------------------------- Settings --- */

export const settingsSchema = z.object({
  version: z.number().int().min(1),
  liveExecutionEnabled: z.boolean(),
  disclosureAcceptedAt: z.string().nullable(),
  defaultMode: executionModeSchema,
  defaultDestinationTeamId: z.string().nullable(),
  actionDelayMs: z.number().int().min(0),
  actionJitterMs: z.number().int().min(0),
  actionTimeoutMs: z.number().int().min(1000),
  discoveryTimeoutMs: z.number().int().min(1000),
  maxRetriesPerAction: z.number().int().min(0).max(10),
  backoffMultiplier: z.number().min(1).max(10),
  circuitBreakerThreshold: z.number().int().min(1).max(100),
  confirmationItemThreshold: z.number().int().min(1),
  requireOwnedByMe: z.boolean(),
  pauseBetweenTeams: z.boolean(),
  probeItemLimitPerTeam: z.number().int().min(0).max(500),
  manualAssistEnabled: z.boolean(),
  debugMode: z.boolean(),
  overrides: userOverridesSchema,
  logRetentionMaxEvents: z.number().int().min(100),
});

export type _SettingsAssignable = AssertAssignable<z.infer<typeof settingsSchema>, Settings>;
export type _SettingsCovers = AssertAssignable<Settings, z.infer<typeof settingsSchema>>;

/* --------------------------------------------------------------- Helpers --- */

export interface ValidationOutcome<T> {
  ok: boolean;
  value: T;
  /** Populated when the raw input failed validation and the default was used. */
  issue: string | null;
}

/**
 * Parses persisted data, falling back to a known-good default instead of
 * throwing. Corrupt storage should degrade to a fresh state with a logged
 * reason, never crash the service worker.
 */
export function parseOrDefault<T>(schema: z.ZodType<T>, raw: unknown, fallback: T): ValidationOutcome<T> {
  if (raw === undefined || raw === null) return { ok: true, value: fallback, issue: null };
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data, issue: null };
  return { ok: false, value: fallback, issue: formatZodIssues(result.error) };
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
