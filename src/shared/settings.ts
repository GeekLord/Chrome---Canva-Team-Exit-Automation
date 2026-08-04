import {
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_SETTINGS_VERSION,
  LOG_RETENTION_MAX_EVENTS,
  MAX_ACTION_DELAY_MS,
  MIN_ACTION_DELAY_MS,
} from './constants';
import type { Settings } from './types';

/**
 * Defaults for a fresh browser profile.
 *
 * Dry run is the default mode and `liveExecutionEnabled` is false, so a first
 * run cannot change anything in Canva until the user deliberately opts in and
 * accepts the disclosure.
 */
export const DEFAULT_SETTINGS: Settings = {
  version: DEFAULT_SETTINGS_VERSION,
  liveExecutionEnabled: false,
  disclosureAcceptedAt: null,
  defaultMode: 'dryRun',
  defaultDestinationTeamId: null,
  actionDelayMs: 1200,
  actionJitterMs: 700,
  actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
  discoveryTimeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS,
  maxRetriesPerAction: 2,
  backoffMultiplier: 2,
  circuitBreakerThreshold: DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  confirmationItemThreshold: 25,
  requireOwnedByMe: true,
  pauseBetweenTeams: true,
  probeItemLimitPerTeam: 10,
  manualAssistEnabled: true,
  debugMode: false,
  overrides: {
    allowTrashWithoutVerification: false,
    allowLeaveWithUnresolvedItems: false,
  },
  logRetentionMaxEvents: 5000,
};

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Enforces the pacing floor regardless of what is in storage. Even a hand-edited
 * settings blob cannot make the extension click through Canva at machine speed.
 */
export function clampSettings(settings: Settings): Settings {
  return {
    ...settings,
    actionDelayMs: clampNumber(settings.actionDelayMs, MIN_ACTION_DELAY_MS, MAX_ACTION_DELAY_MS, DEFAULT_SETTINGS.actionDelayMs),
    actionJitterMs: clampNumber(settings.actionJitterMs, 0, MAX_ACTION_DELAY_MS, DEFAULT_SETTINGS.actionJitterMs),
    actionTimeoutMs: clampNumber(settings.actionTimeoutMs, 2000, 120_000, DEFAULT_SETTINGS.actionTimeoutMs),
    discoveryTimeoutMs: clampNumber(settings.discoveryTimeoutMs, 5000, 600_000, DEFAULT_SETTINGS.discoveryTimeoutMs),
    maxRetriesPerAction: Math.round(clampNumber(settings.maxRetriesPerAction, 0, 10, DEFAULT_SETTINGS.maxRetriesPerAction)),
    backoffMultiplier: clampNumber(settings.backoffMultiplier, 1, 10, DEFAULT_SETTINGS.backoffMultiplier),
    circuitBreakerThreshold: Math.round(
      clampNumber(settings.circuitBreakerThreshold, 1, 100, DEFAULT_SETTINGS.circuitBreakerThreshold),
    ),
    confirmationItemThreshold: Math.round(
      clampNumber(settings.confirmationItemThreshold, 1, 10_000, DEFAULT_SETTINGS.confirmationItemThreshold),
    ),
    logRetentionMaxEvents: Math.round(
      clampNumber(settings.logRetentionMaxEvents, 100, LOG_RETENTION_MAX_EVENTS, DEFAULT_SETTINGS.logRetentionMaxEvents),
    ),
    probeItemLimitPerTeam: Math.round(
      clampNumber(settings.probeItemLimitPerTeam, 0, 500, DEFAULT_SETTINGS.probeItemLimitPerTeam),
    ),
  };
}

/** True once the user has both accepted the disclosure and enabled live runs. */
export function liveExecutionAllowed(settings: Settings): boolean {
  return settings.liveExecutionEnabled && settings.disclosureAcceptedAt !== null;
}
