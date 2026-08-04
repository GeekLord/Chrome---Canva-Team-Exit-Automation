/**
 * Integration harness: a fake `chrome` API plus a scripted stand-in for the
 * content script, so the background engine can be exercised end to end without a
 * browser and without Canva.
 *
 * The fake answers the same validated message protocol the real content script
 * does, which is what makes these tests worth having.
 */

import { normalizeError, type ErrorCategory } from '../shared/errors';
import { createDesignItem } from '../shared/factories';
import type {
  ContentRequest,
  ContentResponse,
  PageStatus,
} from '../shared/messages';
import type { DesignItem, Team } from '../shared/types';

export interface FakeTab {
  id: number;
  url: string;
  status: 'loading' | 'complete';
  active: boolean;
}

export interface RecordedRequest {
  tabId: number;
  type: ContentRequest['type'];
  itemTitle?: string;
  url: string;
}

export interface FakeCanvaOptions {
  teams: Team[];
  itemsByTeam: Record<string, DesignItem[]>;
  /** Explicit success confirmation during copy: yields strong verification. */
  copyShowsConfirmation?: boolean;
  /** Titles present in the destination listing, for the weak verify path. */
  destinationTitles?: string[];
  /** Per-request-type scripted failures. */
  failures?: Partial<Record<ContentRequest['type'], { category: ErrorCategory; times?: number }>>;
  interruption?: PageStatus['interruption'];
  leaveOutcome?: 'success' | 'blocked' | 'navigates';
}

export interface FakeCanva {
  requests: RecordedRequest[];
  navigations: string[];
  handle(tabId: number, request: ContentRequest): ContentResponse;
  countOf(type: ContentRequest['type']): number;
  typesFor(title: string): ContentRequest['type'][];
  setInterruption(kind: PageStatus['interruption']): void;
  copiedTitles: string[];
  trashedTitles: string[];
  leftTeams: string[];
}

const SELECTOR_MAP_VERSION = 'fake-selector-map';

function viewFor(url: string): PageStatus['view'] {
  if (url.includes('/design/')) return 'design';
  if (url.includes('/settings')) return 'settings';
  if (url.includes('/folder/') || url.includes('/projects')) return 'projects';
  return 'other';
}

export function makeFakeCanva(options: FakeCanvaOptions, tabs: FakeTabs): FakeCanva {
  const failureBudget = new Map<string, number>();
  for (const [type, failure] of Object.entries(options.failures ?? {})) {
    failureBudget.set(type, failure?.times ?? Number.POSITIVE_INFINITY);
  }

  let interruption: PageStatus['interruption'] = options.interruption ?? 'none';
  const destinationTitles = new Set(options.destinationTitles ?? []);
  const trashed = new Set<string>();

  const fake: FakeCanva = {
    requests: [],
    navigations: [],
    copiedTitles: [],
    trashedTitles: [],
    leftTeams: [],

    countOf(type) {
      return fake.requests.filter((request) => request.type === type).length;
    },

    typesFor(title) {
      return fake.requests.filter((request) => request.itemTitle === title).map((request) => request.type);
    },

    setInterruption(kind) {
      interruption = kind;
    },

    handle(tabId, request) {
      const tab = tabs.get(tabId);
      const url = tab?.url ?? '';
      fake.requests.push({
        tabId,
        type: request.type,
        url,
        ...('item' in request ? { itemTitle: request.item.title } : {}),
      });

      const scripted = options.failures?.[request.type];
      if (scripted) {
        const remaining = failureBudget.get(request.type) ?? 0;
        if (remaining > 0) {
          failureBudget.set(request.type, remaining - 1);
          return { ok: false, error: normalizeError({ category: scripted.category, detail: 'scripted failure' }) };
        }
      }

      switch (request.type) {
        case 'PING':
          return { ok: true, data: { ready: true, url, selectorMapVersion: SELECTOR_MAP_VERSION } };

        case 'DETECT_PAGE':
          return {
            ok: true,
            data: {
              detected: true,
              tabId: null,
              url,
              loggedIn: 'yes',
              currentWorkspaceName: currentWorkspaceName(url, options.teams),
              view: viewFor(url),
              interruption,
              selectorMapVersion: SELECTOR_MAP_VERSION,
              checkedAt: new Date().toISOString(),
            },
          };

        case 'DISCOVER_TEAMS':
          return {
            ok: true,
            data: {
              teams: options.teams.filter((team) => !fake.leftTeams.includes(team.internalId)),
              currentWorkspaceName: currentWorkspaceName(url, options.teams),
              detail: 'fake switcher',
            },
          };

        case 'DISCOVER_ITEMS':
          return {
            ok: true,
            data: {
              items: (options.itemsByTeam[request.teamId] ?? []).filter((item) => !trashed.has(item.title)),
              truncated: false,
              detail: 'fake listing',
            },
          };

        case 'PROBE_ITEM':
          return { ok: true, data: { capability: 'available', detail: 'fake menu had a copy entry' } };

        case 'COPY_ITEM':
          fake.copiedTitles.push(request.item.title);
          destinationTitles.add(request.item.title);
          return {
            ok: true,
            data: {
              detail: 'fake copy',
              sawSuccessConfirmation: options.copyShowsConfirmation ?? false,
            },
          };

        case 'VERIFY_COPY':
          if (!destinationTitles.has(request.item.title)) {
            return {
              ok: false,
              error: normalizeError({ category: 'copy_verification_failed', detail: 'not in fake destination' }),
            };
          }
          return { ok: true, data: { level: 'weak', detail: 'fake title match' } };

        case 'TRASH_ITEM':
          fake.trashedTitles.push(request.item.title);
          trashed.add(request.item.title);
          return { ok: true, data: { detail: 'fake trash' } };

        case 'LEAVE_TEAM': {
          const outcome = options.leaveOutcome ?? 'success';
          if (outcome === 'blocked') {
            return {
              ok: false,
              error: normalizeError({ category: 'leave_blocked_by_policy', detail: 'fake admin policy' }),
            };
          }
          fake.leftTeams.push(request.team.internalId);
          if (outcome === 'navigates') {
            return { ok: false, error: normalizeError({ category: 'unexpected_navigation', detail: 'fake reload' }) };
          }
          return { ok: true, data: { detail: 'fake leave' } };
        }

        case 'SWITCH_WORKSPACE':
          return { ok: true, data: { detail: 'fake switch' } };

        case 'HIGHLIGHT_ITEM':
          return { ok: true, data: { located: true, detail: 'fake highlight' } };

        case 'CLEAR_HIGHLIGHT':
          return { ok: true, data: { detail: 'cleared' } };

        default: {
          const exhaustive: never = request;
          return { ok: false, error: normalizeError({ category: 'unknown', detail: String(exhaustive) }) };
        }
      }
    },
  };

  return fake;
}

function currentWorkspaceName(url: string, teams: readonly Team[]): string {
  const match = teams.find((team) => team.workspaceUrl !== null && url.startsWith(team.workspaceUrl));
  return match?.displayName ?? teams[0]?.displayName ?? 'Unknown workspace';
}

export interface FakeTabs {
  get(tabId: number): FakeTab | undefined;
  all(): FakeTab[];
}

export interface InstalledFakeChrome {
  tabs: FakeTabs;
  storage: Map<string, unknown>;
  navigations: string[];
  restore(): void;
}

/**
 * Installs a `chrome` global covering only what this extension actually uses:
 * `storage.local`, and the `tabs` surface reachable with host permissions.
 */
export function installFakeChrome(options: {
  initialUrl?: string;
  onMessage: (tabId: number, request: ContentRequest) => ContentResponse;
}): InstalledFakeChrome {
  const storage = new Map<string, unknown>();
  const navigations: string[] = [];
  const tabList: FakeTab[] = [
    { id: 1, url: options.initialUrl ?? 'https://www.canva.com/folder/all-projects', status: 'complete', active: true },
  ];

  const tabs: FakeTabs = {
    get: (tabId) => tabList.find((tab) => tab.id === tabId),
    all: () => tabList,
  };

  const previous = (globalThis as { chrome?: unknown }).chrome;

  const fakeChrome = {
    runtime: {
      id: 'fake-extension-id',
      sendMessage: async () => undefined,
      onMessage: { addListener: () => undefined },
      lastError: undefined,
    },
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          const wanted = keys === null ? [...storage.keys()] : Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of wanted) {
            if (storage.has(key)) result[key] = storage.get(key);
          }
          return result;
        },
        async set(entries: Record<string, unknown>) {
          for (const [key, value] of Object.entries(entries)) {
            // Storage round-trips through structured clone in the real thing.
            storage.set(key, JSON.parse(JSON.stringify(value)) as unknown);
          }
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
        },
      },
    },
    scripting: {
      async executeScript() {
        // The fake content script is always "present"; injection is a no-op.
        return [];
      },
    },
    tabs: {
      async query(info: { url?: string }) {
        if (!info.url) return [...tabList];
        return tabList.filter((tab) => tab.url.startsWith('https://www.canva.com'));
      },
      async get(tabId: number) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return tab;
      },
      async update(tabId: number, changes: { url?: string }) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        if (changes.url) {
          tab.url = changes.url;
          navigations.push(changes.url);
        }
        return tab;
      },
      async create(info: { url?: string }) {
        const tab: FakeTab = {
          id: tabList.length + 1,
          url: info.url ?? 'https://www.canva.com/',
          status: 'complete',
          active: true,
        };
        tabList.push(tab);
        navigations.push(tab.url);
        return tab;
      },
      async sendMessage(tabId: number, request: ContentRequest) {
        if (!tabs.get(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.');
        return options.onMessage(tabId, request);
      },
      onRemoved: { addListener: () => undefined },
    },
  };

  (globalThis as { chrome?: unknown }).chrome = fakeChrome;

  return {
    tabs,
    storage,
    navigations,
    restore() {
      (globalThis as { chrome?: unknown }).chrome = previous;
    },
  };
}

export function fakeItems(teamId: string, titles: readonly string[], now: string): DesignItem[] {
  return titles.map((title, index) =>
    createDesignItem({
      title,
      sourceUrl: `https://www.canva.com/design/DAFfake${teamId}${index}/edit`,
      sourceTeamId: teamId,
      now,
      ownerLabel: 'You',
      ownerConfidence: 'high',
      copyCapability: 'unknown',
      // Real discovery flags every freshly found item as not yet probed.
      riskFlags: ['copyActionUnknown'],
    }),
  );
}

/**
 * A wait that yields a macrotask instead of sleeping.
 *
 * Tests must not inject a synchronous no-op: the engine's polling loops would
 * then run entirely in the microtask queue and starve timers, which looks like a
 * hang rather than a fast test.
 */
export function immediateWait(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
