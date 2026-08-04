/**
 * Append-only run log, persisted locally.
 *
 * Events are written as they happen so that closing the popup, refreshing the
 * Canva tab or the service worker being evicted cannot lose the audit trail.
 * Retention is a cap on the newest N events per run, configurable in Options.
 */

import { logKeyForRun, STORAGE_KEYS } from '../shared/storage-keys';
import { logEventSchema } from '../shared/schemas';
import type { LogEvent, LogEventDraft } from '../shared/types';
import { z } from 'zod';

import { materializeLogEvents } from './log-event';

/** Minimal storage surface so the store can be unit-tested without Chrome. */
export interface KeyValueStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(entries: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

const logArraySchema = z.array(logEventSchema);
const runIndexSchema = z.array(z.string());

export interface LogStoreOptions {
  maxEventsPerRun: number;
  /** Mirrors events to the console when debug mode is on. */
  onEvent?: (event: LogEvent) => void;
}

export class LogStore {
  private readonly storage: KeyValueStorage;
  private options: LogStoreOptions;
  private readonly cache = new Map<string, LogEvent[]>();

  constructor(storage: KeyValueStorage, options: LogStoreOptions) {
    this.storage = storage;
    this.options = options;
  }

  setOptions(options: Partial<LogStoreOptions>): void {
    this.options = { ...this.options, ...options };
  }

  async append(runId: string, drafts: readonly LogEventDraft[], now: string): Promise<LogEvent[]> {
    if (drafts.length === 0) return [];
    const events = materializeLogEvents(runId, drafts, now);
    const existing = await this.read(runId);
    const combined = [...existing, ...events];
    const trimmed =
      combined.length > this.options.maxEventsPerRun
        ? combined.slice(combined.length - this.options.maxEventsPerRun)
        : combined;

    this.cache.set(runId, trimmed);
    await this.storage.set({ [logKeyForRun(runId)]: trimmed });
    await this.registerRun(runId);

    if (this.options.onEvent) {
      for (const event of events) this.options.onEvent(event);
    }
    return events;
  }

  async read(runId: string): Promise<LogEvent[]> {
    const cached = this.cache.get(runId);
    if (cached) return cached;

    const key = logKeyForRun(runId);
    const raw = await this.storage.get([key]);
    const parsed = logArraySchema.safeParse(raw[key]);
    const events = parsed.success ? parsed.data : [];
    this.cache.set(runId, events);
    return events;
  }

  /** Newest `count` events, oldest first. */
  async tail(runId: string, count: number): Promise<LogEvent[]> {
    const events = await this.read(runId);
    return count >= events.length ? events : events.slice(events.length - count);
  }

  async listRunIds(): Promise<string[]> {
    const raw = await this.storage.get([STORAGE_KEYS.logIndex]);
    const parsed = runIndexSchema.safeParse(raw[STORAGE_KEYS.logIndex]);
    return parsed.success ? parsed.data : [];
  }

  async purgeRun(runId: string): Promise<void> {
    this.cache.delete(runId);
    await this.storage.remove([logKeyForRun(runId)]);
    const remaining = (await this.listRunIds()).filter((id) => id !== runId);
    await this.storage.set({ [STORAGE_KEYS.logIndex]: remaining });
  }

  async purgeAll(): Promise<void> {
    const runIds = await this.listRunIds();
    this.cache.clear();
    await this.storage.remove([...runIds.map(logKeyForRun), STORAGE_KEYS.logIndex]);
  }

  private async registerRun(runId: string): Promise<void> {
    const runIds = await this.listRunIds();
    if (runIds.includes(runId)) return;
    await this.storage.set({ [STORAGE_KEYS.logIndex]: [...runIds, runId] });
  }
}

/** `chrome.storage.local` adapter. */
export function chromeLocalStorage(): KeyValueStorage {
  return {
    async get(keys) {
      return (await chrome.storage.local.get(keys)) as Record<string, unknown>;
    },
    async set(entries) {
      await chrome.storage.local.set(entries);
    },
    async remove(keys) {
      await chrome.storage.local.remove(keys);
    },
  };
}

/** In-memory adapter for tests and for the dry-run harness. */
export function memoryStorage(initial: Record<string, unknown> = {}): KeyValueStorage & {
  snapshot(): Record<string, unknown>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(keys) {
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (data.has(key)) result[key] = data.get(key);
      }
      return result;
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
    },
    async remove(keys) {
      for (const key of keys) data.delete(key);
    },
    snapshot() {
      return Object.fromEntries(data.entries());
    },
  };
}
