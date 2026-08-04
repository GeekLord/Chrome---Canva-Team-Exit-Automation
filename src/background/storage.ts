/**
 * Local persistence. Everything lives in `chrome.storage.local`; nothing is
 * synced and nothing leaves the machine.
 *
 * Reads are validated. Corrupt or outdated data degrades to a safe default with
 * a reported reason instead of throwing inside the service worker.
 */

import type { KeyValueStorage } from '../logging/log-store';
import { parseOrDefault, runJobSchema, settingsSchema } from '../shared/schemas';
import { clampSettings, DEFAULT_SETTINGS } from '../shared/settings';
import { allPurgeableKeys, STORAGE_KEYS } from '../shared/storage-keys';
import type { RunJob, Settings } from '../shared/types';
import type { RunReport } from '../shared/report';
import { z } from 'zod';

export interface LoadResult<T> {
  value: T;
  /** Non-null when stored data was unusable and a default was substituted. */
  issue: string | null;
}

const reportSchema = z.record(z.string(), z.unknown());

export class ExtensionStore {
  private readonly storage: KeyValueStorage;

  constructor(storage: KeyValueStorage) {
    this.storage = storage;
  }

  async loadSettings(): Promise<LoadResult<Settings>> {
    const raw = await this.storage.get([STORAGE_KEYS.settings]);
    const parsed = parseOrDefault(settingsSchema, raw[STORAGE_KEYS.settings], DEFAULT_SETTINGS);
    return { value: clampSettings(parsed.value), issue: parsed.issue };
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    const safe = clampSettings(settings);
    await this.storage.set({ [STORAGE_KEYS.settings]: safe });
    return safe;
  }

  async loadRun(): Promise<LoadResult<RunJob | null>> {
    const raw = await this.storage.get([STORAGE_KEYS.activeRun]);
    const stored = raw[STORAGE_KEYS.activeRun];
    if (stored === undefined || stored === null) return { value: null, issue: null };

    const parsed = runJobSchema.safeParse(stored);
    if (parsed.success) return { value: parsed.data, issue: null };

    return {
      value: null,
      issue: `Stored run could not be read and was discarded: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    };
  }

  async saveRun(job: RunJob): Promise<void> {
    await this.storage.set({ [STORAGE_KEYS.activeRun]: job });
  }

  async clearRun(): Promise<void> {
    await this.storage.remove([STORAGE_KEYS.activeRun]);
  }

  async saveReport(report: RunReport): Promise<void> {
    await this.storage.set({ [STORAGE_KEYS.lastReport]: report });
  }

  async loadReport(): Promise<unknown | null> {
    const raw = await this.storage.get([STORAGE_KEYS.lastReport]);
    const parsed = reportSchema.safeParse(raw[STORAGE_KEYS.lastReport]);
    return parsed.success ? parsed.data : null;
  }

  /** One-click purge: settings, run state, report and every stored log. */
  async purgeAll(logRunIds: readonly string[]): Promise<void> {
    await this.storage.remove(allPurgeableKeys(logRunIds));
  }
}
