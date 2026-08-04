/**
 * Every `chrome.storage.local` key the extension uses. Keys are versioned so a
 * future schema change can migrate instead of silently misreading old data.
 *
 * Nothing is written to `chrome.storage.sync`: run state and logs stay on the
 * machine that produced them.
 */

export const STORAGE_KEYS = {
  settings: 'ctea.settings.v1',
  /** The single in-progress or most recent run. */
  activeRun: 'ctea.run.active.v1',
  /** Snapshot of the last finished run, for the end-of-run report. */
  lastReport: 'ctea.run.lastReport.v1',
  /** Index of run ids that still have logs stored. */
  logIndex: 'ctea.logs.index.v1',
  /** Prefix for per-run log arrays: `ctea.logs.run.<runId>`. */
  logPrefix: 'ctea.logs.run.',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

export function logKeyForRun(runId: string): string {
  return `${STORAGE_KEYS.logPrefix}${runId}`;
}

export function isLogKey(key: string): boolean {
  return key.startsWith(STORAGE_KEYS.logPrefix);
}

/** All keys the "purge local data" control must clear, given a log index. */
export function allPurgeableKeys(runIds: readonly string[]): string[] {
  return [
    STORAGE_KEYS.settings,
    STORAGE_KEYS.activeRun,
    STORAGE_KEYS.lastReport,
    STORAGE_KEYS.logIndex,
    ...runIds.map(logKeyForRun),
  ];
}
