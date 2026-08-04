/**
 * Canva page detection and interruption detection.
 *
 * Interruption detection is a safety feature, not a convenience: if Canva shows
 * a sign-in wall or an abuse-prevention challenge, every action stops and the
 * operator is told. The extension never clicks through those screens.
 */

import { ActionError } from '../shared/errors';
import type { CanvaView, InterruptionKind, LoggedInHeuristic, PageStatus } from '../shared/messages';

import { resolve, visibleText } from './dom-utils';
import { SELECTOR_MAP_VERSION, SELECTORS } from './selector-map';

export function detectView(pathname: string = location.pathname): CanvaView {
  if (pathname.includes('/design/')) return 'design';
  if (pathname.includes('/settings')) return 'settings';
  if (pathname.includes('/folder/') || pathname.includes('/projects')) return 'projects';
  if (pathname === '/' || pathname === '') return 'home';
  return 'other';
}

export function detectInterruption(): InterruptionKind {
  if (resolve(SELECTORS.captchaWall)) return 'captcha';
  if (resolve(SELECTORS.authWall)) return 'auth';
  return 'none';
}

export function detectLoggedIn(): LoggedInHeuristic {
  if (resolve(SELECTORS.authWall)) return 'no';
  if (resolve(SELECTORS.accountMenuTrigger)) return 'yes';
  if (resolve(SELECTORS.appShell)) return 'yes';
  return 'unknown';
}

export function detectCurrentWorkspaceName(): string | null {
  const labelled = resolve(SELECTORS.currentWorkspaceLabel);
  if (labelled) {
    const text = visibleText(labelled.element);
    if (text.length > 0) return text;
  }
  const trigger = resolve(SELECTORS.workspaceSwitcherTrigger);
  if (trigger) {
    const text = visibleText(trigger.element);
    if (text.length > 0) return text;
  }
  return null;
}

export function buildPageStatus(now: string): PageStatus {
  return {
    detected: true,
    tabId: null,
    url: location.href,
    loggedIn: detectLoggedIn(),
    currentWorkspaceName: detectCurrentWorkspaceName(),
    view: detectView(),
    interruption: detectInterruption(),
    selectorMapVersion: SELECTOR_MAP_VERSION,
    checkedAt: now,
  };
}

/**
 * Called at the start of every action. Halting here is what keeps the extension
 * from looping against a challenge screen.
 */
export function assertNoInterruption(): void {
  const interruption = detectInterruption();
  if (interruption === 'captcha') {
    throw new ActionError(
      'rate_limited_or_captcha',
      'Canva is showing a verification or rate-limit screen',
      describeInterruption(),
    );
  }
  if (interruption === 'auth') {
    throw new ActionError('auth_required', 'Canva is asking you to sign in again', describeInterruption());
  }
}

function describeInterruption(): string {
  const captcha = resolve(SELECTORS.captchaWall);
  const auth = resolve(SELECTORS.authWall);
  const parts: string[] = [`url=${location.href}`];
  if (captcha) parts.push(`captchaCandidate=${captcha.candidate.description}`);
  if (auth) parts.push(`authCandidate=${auth.candidate.description}`);
  return parts.join('; ');
}

/** Guards against acting on a page that navigated mid-action. */
export function assertStillOnView(expected: CanvaView): void {
  const actual = detectView();
  if (actual !== expected) {
    throw new ActionError(
      'unexpected_navigation',
      `Expected the ${expected} view but the tab is on ${actual}`,
      `url=${location.href}`,
    );
  }
}
