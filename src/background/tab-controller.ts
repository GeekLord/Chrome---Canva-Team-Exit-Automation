/**
 * Owns the Canva tab: finding it, navigating it, and talking to the content
 * script with validated payloads.
 *
 * Navigation lives here rather than in the content script because a page load
 * destroys the content script and any in-flight response with it. The engine
 * therefore navigates first, waits for the script to come back, and only then
 * asks for a single-page action.
 */

import { z } from 'zod';

import {
  CANVA_ORIGIN,
  CANVA_PROJECT_LIST_PATHS,
  CANVA_URL_PATTERN,
} from '../shared/constants';
import { normalizeError, type NormalizedError } from '../shared/errors';
import {
  contentResponseEnvelopeSchema,
  pageStatusSchema,
  pingResultSchema,
  type CanvaView,
  type ContentRequest,
  type PageStatus,
} from '../shared/messages';
import type { Destination, Team } from '../shared/types';

import { sleep } from './pacing';

/** Thrown when a content action reports a normalized failure. */
export class ContentActionFailure extends Error {
  readonly normalized: NormalizedError;

  constructor(normalized: NormalizedError) {
    super(normalized.message);
    this.name = 'ContentActionFailure';
    this.normalized = normalized;
  }
}

const CONNECTION_HINTS = [
  'could not establish connection',
  'receiving end does not exist',
  'message port closed',
  'no tab with id',
  'the tab was closed',
];

function isConnectionError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return CONNECTION_HINTS.some((hint) => text.includes(hint));
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export interface NavigationOptions {
  /** Total budget for load plus view confirmation. */
  timeoutMs: number;
  expectedView?: CanvaView;
}

export class TabController {
  /** Tab the engine is currently driving. */
  private tabId: number | null = null;

  /**
   * Injectable wait, so integration tests can run the real navigation and
   * readiness logic without waiting on wall-clock delays.
   */
  private readonly wait: (ms: number) => Promise<void>;

  constructor(wait: (ms: number) => Promise<void> = sleep) {
    this.wait = wait;
  }

  async findCanvaTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({ url: CANVA_URL_PATTERN });
    const active = tabs.find((tab) => tab.active && tab.id !== undefined);
    const usable = active ?? tabs.find((tab) => tab.id !== undefined);
    return usable ?? null;
  }

  /**
   * Resolves the tab to drive, opening the Canva projects page if none is open.
   * Only ever called from an explicit user action in the popup.
   */
  async ensureCanvaTab(timeoutMs: number): Promise<number> {
    if (this.tabId !== null) {
      const existing = await this.getTab(this.tabId);
      if (existing) return this.tabId;
      this.tabId = null;
    }

    const found = await this.findCanvaTab();
    if (found?.id !== undefined) {
      this.tabId = found.id;
      await this.waitForContentReady(this.tabId, timeoutMs);
      return this.tabId;
    }

    const created = await chrome.tabs.create({
      url: `${CANVA_ORIGIN}${CANVA_PROJECT_LIST_PATHS[0]}`,
      active: true,
    });
    if (created.id === undefined) {
      throw new ContentActionFailure(
        normalizeError({ category: 'unknown', detail: 'Chrome did not return an id for the new tab' }),
      );
    }
    this.tabId = created.id;
    await this.waitForContentReady(this.tabId, timeoutMs);
    return this.tabId;
  }

  getActiveTabId(): number | null {
    return this.tabId;
  }

  forget(tabId: number): void {
    if (this.tabId === tabId) this.tabId = null;
  }

  private async getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------ messaging --- */

  async send<TSchema extends z.ZodTypeAny>(
    tabId: number,
    request: ContentRequest,
    schema: TSchema,
  ): Promise<{ data: z.infer<TSchema>; debug: string[] }> {
    let raw: unknown;
    try {
      raw = await chrome.tabs.sendMessage(tabId, request);
    } catch (error) {
      if (isConnectionError(error)) {
        throw new ContentActionFailure(
          normalizeError({
            category: 'unexpected_navigation',
            message: 'Lost contact with the Canva tab',
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      throw new ContentActionFailure(
        normalizeError({
          category: 'unknown',
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    const envelope = contentResponseEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new ContentActionFailure(
        normalizeError({
          category: 'unknown',
          message: 'The Canva tab returned an unreadable response',
          detail: JSON.stringify(raw)?.slice(0, 500) ?? 'undefined',
        }),
      );
    }

    if (!envelope.data.ok) {
      throw new ContentActionFailure(envelope.data.error);
    }

    const payload = schema.safeParse(envelope.data.data);
    if (!payload.success) {
      throw new ContentActionFailure(
        normalizeError({
          category: 'unknown',
          message: 'The Canva tab returned an unexpected payload',
          detail: payload.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        }),
      );
    }

    return { data: payload.data as z.infer<TSchema>, debug: envelope.data.debug ?? [] };
  }

  /**
   * For actions that may navigate the page as a side effect (switching
   * workspace, leaving a team). A lost connection is reported rather than
   * treated as a failure, so the caller can verify the outcome instead.
   */
  async sendTolerateNavigation<TSchema extends z.ZodTypeAny>(
    tabId: number,
    request: ContentRequest,
    schema: TSchema,
  ): Promise<{ kind: 'response'; data: z.infer<TSchema>; debug: string[] } | { kind: 'navigated'; detail: string }> {
    try {
      const result = await this.send(tabId, request, schema);
      return { kind: 'response', data: result.data, debug: result.debug };
    } catch (error) {
      if (error instanceof ContentActionFailure && error.normalized.category === 'unexpected_navigation') {
        return { kind: 'navigated', detail: error.normalized.detail ?? 'connection lost' };
      }
      throw error;
    }
  }

  /* -------------------------------------------------------------- readiness --- */

  async ping(tabId: number): Promise<boolean> {
    try {
      await this.send(tabId, { type: 'PING' }, pingResultSchema);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Injects the content script on demand.
   *
   * A Canva tab that was already open when the extension was installed or
   * updated has no content script in it, and the declared one only arrives on the
   * next page load. Injecting once here means the tool works immediately after
   * install without asking the user to reload. Re-injection is harmless: the
   * content script guards against installing its listener twice.
   */
  private async injectContentScript(tabId: number): Promise<boolean> {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return true;
    } catch {
      return false;
    }
  }

  async waitForContentReady(tabId: number, timeoutMs: number): Promise<void> {
    const expiresAt = Date.now() + Math.max(1000, timeoutMs);
    let lastError = 'content script did not respond';

    while (Date.now() < expiresAt) {
      const tab = await this.getTab(tabId);
      if (!tab) {
        throw new ContentActionFailure(
          normalizeError({ category: 'unexpected_navigation', message: 'The Canva tab was closed' }),
        );
      }
      if (tab.status === 'complete') {
        if (await this.ping(tabId)) return;
        if (await this.injectContentScript(tabId)) {
          if (await this.ping(tabId)) return;
          lastError = 'content script was injected but did not answer';
        } else {
          lastError = 'content script could not be injected';
        }
      } else {
        lastError = `tab status=${tab.status ?? 'unknown'}`;
      }
      await this.wait(400);
    }

    throw new ContentActionFailure(
      normalizeError({
        category: 'unexpected_navigation',
        message: 'The Canva tab did not become ready in time',
        detail: lastError,
      }),
    );
  }

  async detectPage(tabId: number): Promise<PageStatus> {
    const result = await this.send(tabId, { type: 'DETECT_PAGE' }, pageStatusSchema);
    return { ...result.data, tabId };
  }

  /** Throws with the right category when Canva is showing a wall. */
  assertUsable(page: PageStatus): void {
    if (page.interruption === 'captcha') {
      throw new ContentActionFailure(
        normalizeError({ category: 'rate_limited_or_captcha', detail: `url=${page.url ?? 'unknown'}` }),
      );
    }
    if (page.interruption === 'auth' || page.loggedIn === 'no') {
      throw new ContentActionFailure(
        normalizeError({ category: 'auth_required', detail: `url=${page.url ?? 'unknown'}` }),
      );
    }
  }

  /* ------------------------------------------------------------ navigation --- */

  async navigate(tabId: number, url: string, options: NavigationOptions): Promise<PageStatus> {
    const current = await this.getTab(tabId);
    const alreadyThere = current?.url !== undefined && normalizeUrl(current.url) === normalizeUrl(url);

    if (!alreadyThere) {
      await chrome.tabs.update(tabId, { url });
      // Give Chrome a moment to tear down the old document before polling.
      await this.wait(300);
    }

    await this.waitForContentReady(tabId, options.timeoutMs);
    return await this.waitForView(tabId, options);
  }

  async waitForView(tabId: number, options: NavigationOptions): Promise<PageStatus> {
    const expiresAt = Date.now() + Math.max(1000, options.timeoutMs);
    let page = await this.detectPage(tabId);

    while (Date.now() < expiresAt) {
      this.assertUsable(page);
      if (!options.expectedView || page.view === options.expectedView) return page;
      await this.wait(500);
      page = await this.detectPage(tabId);
    }

    this.assertUsable(page);
    throw new ContentActionFailure(
      normalizeError({
        category: 'unexpected_navigation',
        message: `Canva did not reach the ${options.expectedView ?? 'expected'} view`,
        detail: `url=${page.url ?? 'unknown'} view=${page.view}`,
      }),
    );
  }

  /* ------------------------------------------------------ workspace routing --- */

  projectListUrl(team: Team | null): string {
    if (team?.workspaceUrl) return team.workspaceUrl;
    return `${CANVA_ORIGIN}${CANVA_PROJECT_LIST_PATHS[0]}`;
  }

  /**
   * Puts the tab on the given team's project listing.
   *
   * Preferred path is the workspace URL that discovery read from Canva's own
   * switcher link. The in-page switcher click is the fallback for teams whose
   * link could not be read.
   */
  async ensureTeamProjects(tabId: number, team: Team, options: NavigationOptions): Promise<PageStatus> {
    let page = await this.detectPage(tabId);
    this.assertUsable(page);

    if (isOnWorkspace(page, team) && page.view === 'projects') return page;

    if (team.workspaceUrl) {
      page = await this.navigate(tabId, team.workspaceUrl, { timeoutMs: options.timeoutMs });
      if (page.view !== 'projects') {
        page = await this.navigate(tabId, `${CANVA_ORIGIN}${CANVA_PROJECT_LIST_PATHS[0]}`, {
          timeoutMs: options.timeoutMs,
          expectedView: 'projects',
        });
      }
      return page;
    }

    // No usable link: fall back to driving Canva's switcher in the page.
    await this.sendTolerateNavigation(
      tabId,
      {
        type: 'SWITCH_WORKSPACE',
        team,
        options: {
          timeoutMs: options.timeoutMs,
          stepDelayMs: 600,
          stepJitterMs: 300,
          debug: false,
          dryRun: false,
        },
      },
      z.object({ detail: z.string() }),
    );

    await this.waitForContentReady(tabId, options.timeoutMs);
    return await this.navigate(tabId, `${CANVA_ORIGIN}${CANVA_PROJECT_LIST_PATHS[0]}`, {
      timeoutMs: options.timeoutMs,
      expectedView: 'projects',
    });
  }

  async ensureDestinationProjects(
    tabId: number,
    destination: Destination,
    options: NavigationOptions,
  ): Promise<PageStatus> {
    const url = destination.workspaceUrl ?? `${CANVA_ORIGIN}${CANVA_PROJECT_LIST_PATHS[0]}`;
    const page = await this.navigate(tabId, url, { timeoutMs: options.timeoutMs });
    if (page.view === 'projects') return page;
    return await this.navigate(tabId, `${CANVA_ORIGIN}${CANVA_PROJECT_LIST_PATHS[0]}`, {
      timeoutMs: options.timeoutMs,
      expectedView: 'projects',
    });
  }

  /** Candidate settings URLs that expose the leave control, in order. */
  teamSettingsUrls(): string[] {
    return ['/settings/your-teams', '/settings/people'].map((path) => `${CANVA_ORIGIN}${path}`);
  }
}

function normalize(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isOnWorkspace(page: PageStatus, team: Team): boolean {
  const current = normalize(page.currentWorkspaceName);
  const wanted = normalize(team.displayName);
  if (current.length === 0 || wanted.length === 0) return false;
  return current.includes(wanted) || wanted.includes(current);
}
