import { beforeEach, describe, expect, it } from 'vitest';

import { NOW } from '../testing/fixtures';
import { STORAGE_KEYS, logKeyForRun } from '../shared/storage-keys';
import type { LogEventDraft } from '../shared/types';
import { LogStore, memoryStorage } from './log-store';

function draft(message: string, overrides: Partial<LogEventDraft> = {}): LogEventDraft {
  return {
    level: 'info',
    entityType: 'item',
    entityId: 'item_1',
    action: 'copyItem',
    message,
    detail: null,
    sourceTeamId: 'team_source',
    sourceTeamName: 'Design Studio',
    itemTitle: 'Quarterly report',
    resultStatus: 'success',
    verificationLevel: 'strong',
    errorCategory: null,
    screenshotRef: null,
    ...overrides,
  };
}

describe('LogStore', () => {
  let storage: ReturnType<typeof memoryStorage>;
  let store: LogStore;

  beforeEach(() => {
    storage = memoryStorage();
    store = new LogStore(storage, { maxEventsPerRun: 5 });
  });

  it('appends events with identity and timestamp filled in', async () => {
    const written = await store.append('run_1', [draft('first')], NOW);
    expect(written).toHaveLength(1);
    expect(written[0]?.runId).toBe('run_1');
    expect(written[0]?.timestamp).toBe(NOW);
    expect(written[0]?.eventId).toMatch(/^evt_/);
  });

  it('keeps the log append-only across calls', async () => {
    await store.append('run_1', [draft('first')], NOW);
    await store.append('run_1', [draft('second'), draft('third')], NOW);

    const events = await store.read('run_1');
    expect(events.map((entry) => entry.message)).toEqual(['first', 'second', 'third']);
  });

  it('persists to storage under a per-run key', async () => {
    await store.append('run_1', [draft('first')], NOW);
    const raw = await storage.get([logKeyForRun('run_1')]);
    expect(Array.isArray(raw[logKeyForRun('run_1')])).toBe(true);
  });

  it('trims to the retention cap, keeping the newest events', async () => {
    for (let index = 1; index <= 8; index += 1) {
      await store.append('run_1', [draft(`event ${index}`)], NOW);
    }
    const events = await store.read('run_1');
    expect(events).toHaveLength(5);
    expect(events[0]?.message).toBe('event 4');
    expect(events.at(-1)?.message).toBe('event 8');
  });

  it('returns the newest slice from tail', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await store.append('run_1', [draft(`event ${index}`)], NOW);
    }
    const tail = await store.tail('run_1', 2);
    expect(tail.map((entry) => entry.message)).toEqual(['event 3', 'event 4']);
  });

  it('tracks run ids in an index', async () => {
    await store.append('run_1', [draft('a')], NOW);
    await store.append('run_2', [draft('b')], NOW);
    expect(await store.listRunIds()).toEqual(['run_1', 'run_2']);
  });

  it('purges one run without touching the others', async () => {
    await store.append('run_1', [draft('a')], NOW);
    await store.append('run_2', [draft('b')], NOW);

    await store.purgeRun('run_1');
    expect(await store.read('run_1')).toEqual([]);
    expect(await store.read('run_2')).toHaveLength(1);
    expect(await store.listRunIds()).toEqual(['run_2']);
  });

  it('purges everything including the index', async () => {
    await store.append('run_1', [draft('a')], NOW);
    await store.purgeAll();

    expect(await store.listRunIds()).toEqual([]);
    expect(storage.snapshot()[STORAGE_KEYS.logIndex]).toBeUndefined();
    expect(storage.snapshot()[logKeyForRun('run_1')]).toBeUndefined();
  });

  it('recovers from corrupt stored logs by starting empty', async () => {
    await storage.set({ [logKeyForRun('run_bad')]: 'not an array' });
    expect(await store.read('run_bad')).toEqual([]);
  });

  it('ignores an empty append', async () => {
    expect(await store.append('run_1', [], NOW)).toEqual([]);
    expect(await store.listRunIds()).toEqual([]);
  });

  it('notifies the debug observer for each event', async () => {
    const seen: string[] = [];
    store.setOptions({ onEvent: (entry) => seen.push(entry.message) });
    await store.append('run_1', [draft('one'), draft('two')], NOW);
    expect(seen).toEqual(['one', 'two']);
  });
});
