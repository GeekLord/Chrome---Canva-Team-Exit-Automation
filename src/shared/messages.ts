/**
 * Message protocol.
 *
 * Three directions, all validated at the boundary:
 *   popup/options -> background   `UiCommand`      -> `UiResponse`
 *   background    -> content      `ContentRequest` -> `ContentResponse`
 *   background    -> popup/options `BroadcastMessage` (fire and forget)
 */

import { z } from 'zod';

import type { ErrorCategory, NormalizedError } from './errors';
import type { PlannedAction } from './planner';
import {
  confirmationScopeSchema,
  designItemSchema,
  destinationSchema,
  executionModeSchema,
  normalizedErrorSchema,
  settingsSchema,
  teamSchema,
  userOverridesSchema,
} from './schemas';
import type {
  ConfirmationScope,
  CopyCapability,
  DesignItem,
  Destination,
  ExecutionMode,
  LogEvent,
  RunJob,
  Settings,
  Team,
  UserOverrides,
} from './types';

/* -------------------------------------------------------------- page state --- */

export type LoggedInHeuristic = 'yes' | 'no' | 'unknown';

export type CanvaView = 'projects' | 'design' | 'settings' | 'home' | 'other' | 'unknown';

export type InterruptionKind = 'none' | 'auth' | 'captcha';

export interface PageStatus {
  detected: boolean;
  tabId: number | null;
  url: string | null;
  loggedIn: LoggedInHeuristic;
  currentWorkspaceName: string | null;
  view: CanvaView;
  interruption: InterruptionKind;
  /** Selector map version the content script was built with. */
  selectorMapVersion: string;
  checkedAt: string;
}

export const pageStatusSchema = z.object({
  detected: z.boolean(),
  tabId: z.number().nullable(),
  url: z.string().nullable(),
  loggedIn: z.enum(['yes', 'no', 'unknown']),
  currentWorkspaceName: z.string().nullable(),
  view: z.enum(['projects', 'design', 'settings', 'home', 'other', 'unknown']),
  interruption: z.enum(['none', 'auth', 'captcha']),
  selectorMapVersion: z.string(),
  checkedAt: z.string(),
});

/* ---------------------------------------------------------------- snapshot --- */

export interface RunSnapshot {
  job: RunJob;
  /** Workspaces found in the session; not all of them are run sources. */
  discoveredTeams: Team[];
  settings: Settings;
  page: PageStatus;
  plan: {
    next: PlannedAction | null;
    description: string | null;
    remainingItems: number;
  };
  requiredConfirmations: ConfirmationScope[];
  missingConfirmations: ConfirmationScope[];
  startGuard: { allowed: boolean; reason: string | null };
  /** Tail of the run log, newest last, for the error summary panel. */
  recentLogs: LogEvent[];
  /** True while the engine is mid-action; UI disables conflicting controls. */
  engineBusy: boolean;
  selectorMapVersion: string;
}

/* ------------------------------------------------------------- ui commands --- */

export const uiCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('GET_SNAPSHOT') }),
  z.object({ type: z.literal('GET_SETTINGS') }),
  z.object({ type: z.literal('UPDATE_SETTINGS'), patch: settingsSchema.partial() }),
  z.object({ type: z.literal('RESET_SETTINGS') }),
  z.object({ type: z.literal('ACCEPT_DISCLOSURE') }),
  z.object({ type: z.literal('SCAN_TEAMS') }),
  z.object({ type: z.literal('SELECT_TEAMS'), teamIds: z.array(z.string()) }),
  z.object({ type: z.literal('SELECT_DESTINATION'), teamId: z.string().nullable() }),
  z.object({ type: z.literal('SELECT_MODE'), mode: executionModeSchema }),
  z.object({ type: z.literal('SCAN_ITEMS') }),
  z.object({ type: z.literal('SET_ITEM_INCLUSION'), itemId: z.string(), selected: z.boolean() }),
  z.object({ type: z.literal('SET_ALL_INCLUSIONS'), selected: z.boolean(), teamId: z.string().nullable() }),
  z.object({ type: z.literal('GRANT_CONFIRMATION'), scope: confirmationScopeSchema }),
  z.object({ type: z.literal('REVOKE_CONFIRMATION'), scope: confirmationScopeSchema }),
  z.object({ type: z.literal('CONFIRM_LEAVE'), teamId: z.string() }),
  z.object({ type: z.literal('SET_OVERRIDES'), overrides: userOverridesSchema.partial() }),
  z.object({ type: z.literal('START_RUN') }),
  z.object({ type: z.literal('PAUSE_RUN') }),
  z.object({ type: z.literal('RESUME_RUN') }),
  z.object({ type: z.literal('STOP_RUN') }),
  z.object({ type: z.literal('RETRY_ITEM'), itemId: z.string() }),
  z.object({ type: z.literal('SKIP_ITEM'), itemId: z.string(), reason: z.string().optional() }),
  z.object({
    type: z.literal('RESOLVE_MANUAL_ASSIST'),
    itemId: z.string(),
    outcome: z.enum(['done', 'skip']),
  }),
  z.object({ type: z.literal('SKIP_LEAVE'), teamId: z.string() }),
  z.object({ type: z.literal('NEW_RUN') }),
  z.object({ type: z.literal('GET_LOGS'), runId: z.string().optional() }),
  z.object({ type: z.literal('PURGE_LOCAL_DATA') }),
]);

export type UiCommand = z.infer<typeof uiCommandSchema>;

export type UiResponse =
  | { ok: true; kind: 'ack' }
  | { ok: true; kind: 'snapshot'; snapshot: RunSnapshot }
  | { ok: true; kind: 'settings'; settings: Settings }
  | { ok: true; kind: 'logs'; logs: LogEvent[] }
  | { ok: false; kind: 'error'; message: string; category: ErrorCategory; nextStep: string | null };

export function uiError(message: string, category: ErrorCategory = 'unknown', nextStep: string | null = null): UiResponse {
  return { ok: false, kind: 'error', message, category, nextStep };
}

/* ------------------------------------------------------------- broadcasts --- */

export type BroadcastMessage =
  | { type: 'SNAPSHOT_UPDATED'; snapshot: RunSnapshot }
  | { type: 'RUN_ATTENTION'; message: string; category: ErrorCategory | null };

export const broadcastMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SNAPSHOT_UPDATED'), snapshot: z.unknown() }),
  z.object({ type: z.literal('RUN_ATTENTION'), message: z.string(), category: z.string().nullable() }),
]);

/* -------------------------------------------------------- content protocol --- */

/** Pacing and resilience knobs handed to every content action. */
export interface ActionOptions {
  timeoutMs: number;
  /** Base delay applied between individual DOM interactions. */
  stepDelayMs: number;
  stepJitterMs: number;
  debug: boolean;
  /** Hard switch: when true the content script refuses mutating actions. */
  dryRun: boolean;
}

export const actionOptionsSchema = z.object({
  timeoutMs: z.number().int().positive(),
  stepDelayMs: z.number().int().min(0),
  stepJitterMs: z.number().int().min(0),
  debug: z.boolean(),
  dryRun: z.boolean(),
});

export interface CopyItemResult {
  detail: string;
  /** True when Canva showed an explicit success confirmation during the copy. */
  sawSuccessConfirmation: boolean;
}

export interface VerifyCopyResult {
  level: 'strong' | 'weak';
  detail: string;
}

export interface ProbeItemResult {
  capability: CopyCapability;
  detail: string;
}

export interface DiscoverTeamsResult {
  teams: Team[];
  currentWorkspaceName: string | null;
  detail: string;
}

export interface DiscoverItemsResult {
  items: DesignItem[];
  /** True when discovery stopped on a timeout rather than reaching the end. */
  truncated: boolean;
  detail: string;
}

export interface SimpleActionResult {
  detail: string;
}

export const contentRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PING') }),
  z.object({ type: z.literal('DETECT_PAGE') }),
  z.object({ type: z.literal('DISCOVER_TEAMS'), options: actionOptionsSchema }),
  z.object({
    type: z.literal('SWITCH_WORKSPACE'),
    team: teamSchema,
    options: actionOptionsSchema,
  }),
  z.object({
    type: z.literal('DISCOVER_ITEMS'),
    teamId: z.string(),
    requireOwnedByMe: z.boolean(),
    options: actionOptionsSchema,
  }),
  z.object({ type: z.literal('PROBE_ITEM'), item: designItemSchema, options: actionOptionsSchema }),
  z.object({
    type: z.literal('COPY_ITEM'),
    item: designItemSchema,
    destination: destinationSchema,
    options: actionOptionsSchema,
  }),
  z.object({
    type: z.literal('VERIFY_COPY'),
    item: designItemSchema,
    destination: destinationSchema,
    options: actionOptionsSchema,
  }),
  z.object({ type: z.literal('TRASH_ITEM'), item: designItemSchema, options: actionOptionsSchema }),
  z.object({ type: z.literal('LEAVE_TEAM'), team: teamSchema, options: actionOptionsSchema }),
  z.object({
    type: z.literal('HIGHLIGHT_ITEM'),
    item: designItemSchema,
    instruction: z.string(),
    options: actionOptionsSchema,
  }),
  z.object({ type: z.literal('CLEAR_HIGHLIGHT') }),
]);

export type ContentRequest = z.infer<typeof contentRequestSchema>;

export type ContentResponse<TData = unknown> =
  | { ok: true; data: TData; debug?: string[] }
  | { ok: false; error: NormalizedError; debug?: string[] };

/** Envelope validation; the `data` payload is parsed per request type. */
export const contentResponseEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown(), debug: z.array(z.string()).optional() }),
  z.object({ ok: z.literal(false), error: normalizedErrorSchema, debug: z.array(z.string()).optional() }),
]);

export interface PingResult {
  ready: true;
  url: string;
  selectorMapVersion: string;
}

export const pingResultSchema = z.object({
  ready: z.literal(true),
  url: z.string(),
  selectorMapVersion: z.string(),
});

export interface HighlightResultPayload {
  located: boolean;
  detail: string;
}

export const highlightResultSchema = z.object({ located: z.boolean(), detail: z.string() });

export const discoverTeamsResultSchema = z.object({
  teams: z.array(teamSchema),
  currentWorkspaceName: z.string().nullable(),
  detail: z.string(),
});

export const discoverItemsResultSchema = z.object({
  items: z.array(designItemSchema),
  truncated: z.boolean(),
  detail: z.string(),
});

export const copyItemResultSchema = z.object({
  detail: z.string(),
  sawSuccessConfirmation: z.boolean(),
});

export const verifyCopyResultSchema = z.object({
  level: z.enum(['strong', 'weak']),
  detail: z.string(),
});

export const probeItemResultSchema = z.object({
  capability: z.enum(['available', 'unavailable', 'unknown']),
  detail: z.string(),
});

export const simpleActionResultSchema = z.object({ detail: z.string() });

/* --------------------------------------------------------------- narrowing --- */

export type UiCommandOfType<T extends UiCommand['type']> = Extract<UiCommand, { type: T }>;

export type ContentRequestOfType<T extends ContentRequest['type']> = Extract<ContentRequest, { type: T }>;

/** Type guard used by the content script's message listener. */
export function parseContentRequest(raw: unknown): ContentRequest | null {
  const result = contentRequestSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function parseUiCommand(raw: unknown): UiCommand | null {
  const result = uiCommandSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/* Re-exported so UI modules import domain types from one place. */
export type {
  ConfirmationScope,
  DesignItem,
  Destination,
  ExecutionMode,
  LogEvent,
  RunJob,
  Settings,
  Team,
  UserOverrides,
};
