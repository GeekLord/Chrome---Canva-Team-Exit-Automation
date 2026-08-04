/**
 * DOM utilities: selector resolution with per-candidate fallback, waiting with
 * deadlines, stale-element recovery, and human-ish clicking.
 *
 * This module is the only place allowed to touch `document` directly for
 * querying. Action executors go through `resolve*` / `waitFor*` so every lookup
 * is traceable to a selector-map candidate.
 */

import { ActionError } from '../shared/errors';

import type { SelectorCandidate, SelectorSpec } from './selector-map';

/* ------------------------------------------------------------------ timing --- */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** Base delay plus a random slice of jitter, so actions are not metronomic. */
export function jitteredDelay(baseMs: number, jitterMs: number): number {
  if (jitterMs <= 0) return Math.max(0, baseMs);
  return Math.max(0, Math.round(baseMs + Math.random() * jitterMs));
}

export class Deadline {
  private readonly expiresAt: number;

  constructor(timeoutMs: number) {
    this.expiresAt = Date.now() + Math.max(0, timeoutMs);
  }

  get remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  get expired(): boolean {
    return this.remainingMs === 0;
  }

  /** A shorter deadline that can never outlive this one. */
  slice(timeoutMs: number): Deadline {
    return new Deadline(Math.min(timeoutMs, this.remainingMs));
  }
}

/* -------------------------------------------------------------- inspection --- */

export function isHtmlElement(node: unknown): node is HTMLElement {
  return typeof HTMLElement !== 'undefined' && node instanceof HTMLElement;
}

function hasLayoutEngine(doc: Document): boolean {
  const body = doc.body as HTMLElement | null;
  if (!body) return false;
  return body.clientHeight > 0 || body.clientWidth > 0;
}

/**
 * Visibility test that degrades gracefully. In a real browser it uses layout
 * boxes; under jsdom (no layout) it falls back to explicit hiding signals so
 * selector tests stay meaningful.
 */
export function isVisible(element: Element): boolean {
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (isHtmlElement(element) && element.hidden) return false;

  const view = element.ownerDocument.defaultView;
  if (view && typeof view.getComputedStyle === 'function') {
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity === '0') return false;
  }

  if (typeof element.getClientRects === 'function' && element.getClientRects().length > 0) return true;
  if (isHtmlElement(element) && (element.offsetWidth > 0 || element.offsetHeight > 0)) return true;

  return !hasLayoutEngine(element.ownerDocument);
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Visible text of an element, preferring rendered text when available. */
export function visibleText(element: Element): string {
  const rendered = isHtmlElement(element) ? element.innerText : null;
  return normalizeText(rendered && rendered.length > 0 ? rendered : element.textContent);
}

/** Same as `visibleText` but case-preserving, for anything shown to the user. */
export function rawText(element: Element): string {
  const rendered = isHtmlElement(element) ? element.innerText : null;
  const source = rendered && rendered.length > 0 ? rendered : (element.textContent ?? '');
  return source.replace(/\s+/g, ' ').trim();
}

/**
 * Accessible name declared by an attribute, or null when the element does not
 * declare one.
 *
 * The `label` selector strategy uses this rather than `accessibleName` on
 * purpose: falling back to descendant text would let a container such as
 * `[role="menu"]` masquerade as the entry inside it, and clicking the container
 * is either useless or wrong.
 */
export function declaredAccessibleName(element: Element): string | null {
  const aria = element.getAttribute('aria-label');
  if (aria && aria.trim().length > 0) return normalizeText(aria);

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)
      .map((node) => visibleText(node));
    const joined = normalizeText(parts.join(' '));
    if (joined.length > 0) return joined;
  }

  const title = element.getAttribute('title');
  if (title && title.trim().length > 0) return normalizeText(title);

  if (element instanceof HTMLImageElement && element.alt) return normalizeText(element.alt);
  if (element instanceof HTMLInputElement && element.placeholder) return normalizeText(element.placeholder);

  return null;
}

/** Approximation of the accessible name, falling back to visible text. */
export function accessibleName(element: Element): string {
  return declaredAccessibleName(element) ?? visibleText(element);
}

export function nameMatches(haystack: string, names: readonly string[], exact = false): boolean {
  const target = normalizeText(haystack);
  if (target.length === 0) return false;
  return names.some((name) => {
    const needle = normalizeText(name);
    if (needle.length === 0) return false;
    return exact ? target === needle : target.includes(needle);
  });
}

/** Nearest ancestor (or self) that can actually receive a click. */
export function closestClickable(element: Element): HTMLElement | null {
  const candidate = element.closest(
    'button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"], input, label, [tabindex]',
  );
  if (isHtmlElement(candidate)) return candidate;
  return isHtmlElement(element) ? element : null;
}

/* ------------------------------------------------------ selector resolution --- */

export interface SelectorMatch {
  element: HTMLElement;
  spec: SelectorSpec;
  candidate: SelectorCandidate;
  candidateIndex: number;
}

export interface ResolveOptions {
  root?: ParentNode;
  /** Extra runtime name filter, e.g. the specific team the run targets. */
  name?: readonly string[];
  exact?: boolean;
  /** Ignore elements matching this predicate. */
  reject?: (element: HTMLElement) => boolean;
}

const IMPLICIT_ROLE_SELECTORS: Record<string, string> = {
  button: 'button, input[type="button"], input[type="submit"]',
  link: 'a[href]',
  list: 'ul, ol',
  listitem: 'li',
  main: 'main',
  navigation: 'nav',
  dialog: 'dialog',
  searchbox: 'input[type="search"]',
  heading: 'h1, h2, h3, h4, h5, h6',
  status: 'output',
  grid: 'table',
  gridcell: 'td',
  progressbar: 'progress',
};

function candidateSelector(candidate: SelectorCandidate): string {
  switch (candidate.strategy) {
    case 'css':
      return candidate.value ?? '*';
    case 'testId': {
      const value = candidate.value ?? '';
      return `[data-testid="${value}"], [data-test-id="${value}"], [data-test="${value}"], [data-anchor="${value}"]`;
    }
    case 'role': {
      const role = candidate.value ?? '';
      const implicit = IMPLICIT_ROLE_SELECTORS[role];
      return implicit ? `[role="${role}"], ${implicit}` : `[role="${role}"]`;
    }
    case 'label':
      return candidate.within ?? '[aria-label], [aria-labelledby], [title], button, a, input, [role]';
    case 'text':
      return candidate.within ?? 'button, a, [role="button"], [role="menuitem"], [role="option"]';
    default: {
      const exhaustive: never = candidate.strategy;
      return String(exhaustive);
    }
  }
}

function queryCandidate(candidate: SelectorCandidate, root: ParentNode): HTMLElement[] {
  let nodes: Element[];
  try {
    nodes = Array.from(root.querySelectorAll(candidateSelector(candidate)));
  } catch {
    // A malformed selector must not take the run down.
    return [];
  }

  const requireVisible = candidate.requireVisible !== false;
  const elements = nodes.filter(isHtmlElement).filter((element) => !requireVisible || isVisible(element));

  if (!candidate.name || candidate.name.length === 0) return elements;

  const names = candidate.name;
  const matched = elements.filter((element) => {
    const declared = declaredAccessibleName(element);
    const byDeclaredName = declared !== null && nameMatches(declared, names, candidate.exact);

    // `label` matches only a declared name; `text` also accepts visible text.
    if (candidate.strategy === 'label') return byDeclaredName;
    return byDeclaredName || nameMatches(visibleText(element), names, candidate.exact);
  });

  // Prefer the most specific match: the element with the least surrounding text.
  return matched.sort((left, right) => visibleText(left).length - visibleText(right).length);
}

export function resolveAll(spec: SelectorSpec, options: ResolveOptions = {}): SelectorMatch[] {
  const root = options.root ?? document;

  for (let index = 0; index < spec.candidates.length; index += 1) {
    const candidate = spec.candidates[index];
    if (!candidate) continue;

    let elements = queryCandidate(candidate, root);

    if (options.name && options.name.length > 0) {
      elements = elements.filter(
        (element) =>
          nameMatches(accessibleName(element), options.name ?? [], options.exact) ||
          nameMatches(visibleText(element), options.name ?? [], options.exact),
      );
    }
    if (options.reject) {
      elements = elements.filter((element) => !options.reject?.(element));
    }

    if (elements.length > 0) {
      return elements.map((element) => ({ element, spec, candidate, candidateIndex: index }));
    }
  }

  return [];
}

export function resolve(spec: SelectorSpec, options: ResolveOptions = {}): SelectorMatch | null {
  return resolveAll(spec, options)[0] ?? null;
}

/** Per-candidate hit counts, attached to `selector_not_found` detail. */
export function describeSpecFailure(spec: SelectorSpec, options: ResolveOptions = {}): string {
  const root = options.root ?? document;
  const lines = spec.candidates.map((candidate, index) => {
    const count = queryCandidate(candidate, root).length;
    return `#${index} ${candidate.strategy} "${candidate.value ?? (candidate.name ?? []).join('|')}" -> ${count} match(es) [${candidate.description}]`;
  });
  const nameNote = options.name ? ` runtimeName=[${options.name.join('|')}] exact=${String(options.exact ?? false)}` : '';
  return `spec=${spec.key} purpose="${spec.purpose}"${nameNote}\n${lines.join('\n')}`;
}

/* -------------------------------------------------------------- waiting --- */

export interface WaitOptions {
  deadline: Deadline;
  intervalMs?: number;
  description: string;
  /** Error category used when the wait times out. */
  category?: ConstructorParameters<typeof ActionError>[0];
}

export async function waitForValue<T>(probe: () => T | null | undefined, options: WaitOptions): Promise<T> {
  const interval = options.intervalMs ?? 150;
  let last: T | null | undefined;
  for (;;) {
    last = probe();
    if (last !== null && last !== undefined) return last;
    if (options.deadline.expired) break;
    await sleep(Math.min(interval, Math.max(1, options.deadline.remainingMs)));
  }
  throw new ActionError(options.category ?? 'selector_not_found', `Timed out waiting for ${options.description}`);
}

export async function waitForCondition(probe: () => boolean, options: WaitOptions): Promise<void> {
  await waitForValue(() => (probe() ? true : null), options);
}

export async function waitForSelector(spec: SelectorSpec, options: WaitOptions & ResolveOptions): Promise<SelectorMatch> {
  try {
    return await waitForValue(() => resolve(spec, options), options);
  } catch (error) {
    if (error instanceof ActionError) {
      throw new ActionError(error.category, error.message, describeSpecFailure(spec, options));
    }
    throw error;
  }
}

export async function waitForSelectorGone(spec: SelectorSpec, options: WaitOptions & ResolveOptions): Promise<void> {
  await waitForCondition(() => resolve(spec, options) === null, options);
}

/* ------------------------------------------------------------ interaction --- */

function dispatchMouseSequence(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView ?? undefined;
  const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...(view ? { view } : {}),
    clientX: rect ? rect.left + rect.width / 2 : 0,
    clientY: rect ? rect.top + rect.height / 2 : 0,
  };

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
    try {
      const isPointer = type.startsWith('pointer');
      if (isPointer && typeof PointerEvent === 'undefined') continue;
      const event = isPointer ? new PointerEvent(type, init) : new MouseEvent(type, init);
      element.dispatchEvent(event);
    } catch {
      // Event constructors can be unavailable in constrained environments.
    }
  }
}

/**
 * Clicks like a user: scroll into view, focus, then a real event sequence.
 * React and Canva's own handlers respond to `click()`; the preceding pointer
 * events matter for components that track press state.
 */
export async function clickElement(element: HTMLElement, options: { settleMs?: number } = {}): Promise<void> {
  if (!element.isConnected) {
    throw new ActionError('selector_not_found', 'Element went stale before it could be clicked');
  }

  if (typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  await sleep(options.settleMs ?? 60);

  if (!element.isConnected) {
    throw new ActionError('selector_not_found', 'Element went stale while scrolling it into view');
  }

  try {
    element.focus({ preventScroll: true });
  } catch {
    // Non-focusable elements are fine to click.
  }

  dispatchMouseSequence(element);

  if (typeof element.click === 'function') {
    element.click();
  } else {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
  }
}

export async function typeIntoField(element: HTMLElement, value: string): Promise<void> {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    throw new ActionError('selector_not_found', 'Target for text entry is not an input field');
  }
  element.focus({ preventScroll: true });
  element.value = '';
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(30);
}

export function pressKey(key: string, target?: HTMLElement): void {
  const node = target ?? (document.activeElement as HTMLElement | null) ?? document.body;
  if (!node) return;
  for (const type of ['keydown', 'keyup'] as const) {
    node.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true }));
  }
}

/** Closes an open menu or dialog without clicking anything destructive. */
export async function dismissOverlay(): Promise<void> {
  pressKey('Escape');
  await sleep(120);
}

/* -------------------------------------------------------------- scrolling --- */

export function scrollableAncestor(element: Element): HTMLElement {
  let current: Element | null = element;
  const view = element.ownerDocument.defaultView;
  while (current && isHtmlElement(current)) {
    if (view && typeof view.getComputedStyle === 'function') {
      const style = view.getComputedStyle(current);
      const scrolls = /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
      if (scrolls && current.scrollHeight > current.clientHeight + 4) return current;
    }
    current = current.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.body;
}

export function scrollToBottom(container: HTMLElement): void {
  if (container === document.body || container === document.scrollingElement) {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
    return;
  }
  container.scrollTop = container.scrollHeight;
}

/* ------------------------------------------------------- stale resilience --- */

/**
 * Retries an operation that failed because the DOM changed underneath it.
 * Only stale/selector failures are retried; real errors propagate immediately.
 */
export async function withStaleRetry<T>(
  operation: () => Promise<T>,
  options: { attempts: number; delayMs: number; onRetry?: (attempt: number, error: unknown) => void },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, options.attempts); attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const staleish =
        error instanceof ActionError &&
        (error.category === 'selector_not_found' ||
          error.category === 'dialog_not_opened' ||
          error.category === 'unexpected_navigation');
      if (!staleish || attempt === options.attempts) break;
      options.onRetry?.(attempt, error);
      await sleep(options.delayMs * attempt);
    }
  }
  throw lastError;
}

/** Text of the most recent live-region message, used to read Canva toasts. */
export function readLiveRegions(spec: SelectorSpec): string[] {
  return resolveAll(spec)
    .map((match) => visibleText(match.element))
    .filter((text) => text.length > 0);
}
