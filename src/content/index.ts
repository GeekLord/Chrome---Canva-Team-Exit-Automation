/**
 * Content script entry point.
 *
 * This script is inert until the background engine asks it to do something. It
 * owns no schedule, no retry policy and no decisions about safety: it receives a
 * validated request, runs one playbook, and reports a normalized result.
 */

import type { ErrorCategory } from '../shared/errors';
import { toNormalizedError } from '../shared/errors';
import type { ContentRequest, ContentResponse } from '../shared/messages';
import { parseContentRequest } from '../shared/messages';

import { createActionContext } from './actions/context';
import { copyItem } from './actions/copy-item';
import { discoverItems } from './actions/discover-items';
import { discoverTeams, switchWorkspace } from './actions/discover-teams';
import { leaveTeam } from './actions/leave-team';
import { probeItem } from './actions/probe-item';
import { trashItem } from './actions/trash-item';
import { verifyCopy } from './actions/verify-copy';
import { buildPageStatus } from './detect';
import { clearHighlight, highlightItem } from './highlight';
import { SELECTOR_MAP_VERSION } from './selector-map';

const INJECTION_FLAG = '__canvaTeamExitAutomationContentReady';

/** Fallback error category per request type, used when nothing more specific applies. */
const FALLBACK_CATEGORY: Record<ContentRequest['type'], ErrorCategory> = {
  PING: 'unknown',
  DETECT_PAGE: 'unknown',
  DISCOVER_TEAMS: 'selector_not_found',
  SWITCH_WORKSPACE: 'destination_not_found',
  DISCOVER_ITEMS: 'selector_not_found',
  PROBE_ITEM: 'selector_not_found',
  COPY_ITEM: 'copy_action_missing',
  VERIFY_COPY: 'copy_verification_failed',
  TRASH_ITEM: 'delete_action_missing',
  LEAVE_TEAM: 'leave_blocked_by_policy',
  HIGHLIGHT_ITEM: 'selector_not_found',
  CLEAR_HIGHLIGHT: 'unknown',
};

const IMMEDIATE_OPTIONS = {
  timeoutMs: 5000,
  stepDelayMs: 0,
  stepJitterMs: 0,
  debug: false,
  dryRun: true,
} as const;

async function handleRequest(request: ContentRequest): Promise<ContentResponse> {
  const debug: string[] = [];
  const options = 'options' in request ? request.options : IMMEDIATE_OPTIONS;
  const ctx = createActionContext(options, (message, detail) => {
    debug.push(detail ? `${message} :: ${detail}` : message);
  });

  try {
    switch (request.type) {
      case 'PING':
        return {
          ok: true,
          data: { ready: true, url: location.href, selectorMapVersion: SELECTOR_MAP_VERSION },
        };

      case 'DETECT_PAGE':
        return { ok: true, data: buildPageStatus(new Date().toISOString()) };

      case 'DISCOVER_TEAMS':
        return { ok: true, data: await discoverTeams(ctx), debug };

      case 'SWITCH_WORKSPACE':
        return { ok: true, data: await switchWorkspace(ctx, request.team), debug };

      case 'DISCOVER_ITEMS':
        return {
          ok: true,
          data: await discoverItems(ctx, { teamId: request.teamId, requireOwnedByMe: request.requireOwnedByMe }),
          debug,
        };

      case 'PROBE_ITEM':
        return { ok: true, data: await probeItem(ctx, request.item), debug };

      case 'COPY_ITEM':
        return { ok: true, data: await copyItem(ctx, request.item, request.destination), debug };

      case 'VERIFY_COPY':
        return { ok: true, data: await verifyCopy(ctx, request.item, request.destination), debug };

      case 'TRASH_ITEM':
        return { ok: true, data: await trashItem(ctx, request.item), debug };

      case 'LEAVE_TEAM':
        return { ok: true, data: await leaveTeam(ctx, request.team), debug };

      case 'HIGHLIGHT_ITEM':
        return { ok: true, data: highlightItem(request.item, request.instruction), debug };

      case 'CLEAR_HIGHLIGHT':
        clearHighlight();
        return { ok: true, data: { detail: 'Highlight cleared' } };

      default: {
        const exhaustive: never = request;
        return {
          ok: false,
          error: toNormalizedError(new Error(`Unhandled content request: ${JSON.stringify(exhaustive)}`)),
        };
      }
    }
  } catch (error) {
    return { ok: false, error: toNormalizedError(error, FALLBACK_CATEGORY[request.type]), debug };
  }
}

function install(): void {
  const globalScope = window as unknown as Record<string, unknown>;
  if (globalScope[INJECTION_FLAG] === true) return;
  globalScope[INJECTION_FLAG] = true;

  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const request = parseContentRequest(raw);
    if (!request) {
      // Not one of ours, or malformed: stay silent rather than guessing.
      return false;
    }

    handleRequest(request).then(
      (response) => sendResponse(response),
      (error: unknown) => sendResponse({ ok: false, error: toNormalizedError(error) } satisfies ContentResponse),
    );

    // Keep the message channel open for the async response.
    return true;
  });
}

install();
