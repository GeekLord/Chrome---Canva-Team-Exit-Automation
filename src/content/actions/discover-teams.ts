/**
 * FR-1 team discovery: read the workspaces this session can switch into.
 *
 * Non-mutating. Opens Canva's own workspace switcher, reads the entries, then
 * closes it with Escape so the page is left as it was found.
 */

import { ActionError } from '../../shared/errors';
import { deriveTeamId } from '../../shared/ids';
import type { DiscoverTeamsResult } from '../../shared/messages';
import type { Team } from '../../shared/types';
import { assertNoInterruption, detectCurrentWorkspaceName } from '../detect';
import {
  accessibleName,
  clickElement,
  describeSpecFailure,
  dismissOverlay,
  normalizeText,
  rawText,
  resolve,
  resolveAll,
  waitForSelector,
} from '../dom-utils';
import { SELECTORS } from '../selector-map';

import type { ActionContext } from './context';

/** Switcher entries that are controls rather than workspaces. */
const NON_WORKSPACE_TEXT = [
  'create a team',
  'create team',
  'new team',
  'add team',
  'join a team',
  'manage teams',
  'team settings',
  'settings',
  'log out',
  'sign out',
  'upgrade',
  'invite',
  'billing',
  'purchase history',
  'account settings',
];

function isWorkspaceEntry(text: string): boolean {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return false;
  if (normalized.length > 120) return false;
  return !NON_WORKSPACE_TEXT.some((candidate) => normalized === candidate || normalized.includes(candidate));
}

function looksPersonal(text: string): boolean {
  const normalized = normalizeText(text);
  return normalized.includes('personal') || normalized.includes('your designs') || normalized.includes('just you');
}

export async function discoverTeams(ctx: ActionContext): Promise<DiscoverTeamsResult> {
  assertNoInterruption();

  const currentWorkspaceName = detectCurrentWorkspaceName();
  const trigger = resolve(SELECTORS.workspaceSwitcherTrigger);

  if (!trigger) {
    // A single-workspace account may not render a switcher at all. Report the
    // current workspace instead of failing the whole scan, and say why.
    const fallbackName = currentWorkspaceName ?? 'Current workspace';
    ctx.debug('Workspace switcher not found; reporting current workspace only');
    return {
      teams: [
        {
          internalId: deriveTeamId({ workspaceUrl: location.origin + location.pathname, displayName: fallbackName }),
          displayName: fallbackName,
          workspaceUrl: null,
          leaveSupportedState: 'unknown',
          discoveryTimestamp: new Date().toISOString(),
          isCurrent: true,
          isPersonal: looksPersonal(fallbackName),
        },
      ],
      currentWorkspaceName,
      detail: `Workspace switcher control was not found, so only the current workspace is listed.\n${describeSpecFailure(
        SELECTORS.workspaceSwitcherTrigger,
      )}`,
    };
  }

  ctx.debug(`Opening workspace switcher via ${trigger.candidate.description}`);
  await clickElement(trigger.element);
  await ctx.step();

  const menu = await waitForSelector(SELECTORS.workspaceSwitcherMenu, {
    ...ctx.wait('the workspace switcher to open', 'dialog_not_opened'),
  });

  const options = resolveAll(SELECTORS.workspaceOption, { root: menu.element });
  const teams: Team[] = [];
  const rejected: string[] = [];
  const now = new Date().toISOString();

  for (const option of options) {
    const label = rawText(option.element) || accessibleName(option.element);
    if (!isWorkspaceEntry(label)) {
      if (label.length > 0) rejected.push(label);
      continue;
    }

    const anchor =
      option.element instanceof HTMLAnchorElement
        ? option.element
        : option.element.querySelector('a[href]') ?? option.element.closest('a[href]');
    const workspaceUrl = anchor instanceof HTMLAnchorElement ? anchor.href : null;

    const isCurrent =
      option.element.getAttribute('aria-current') === 'true' ||
      option.element.getAttribute('aria-selected') === 'true' ||
      (currentWorkspaceName !== null && normalizeText(label) === normalizeText(currentWorkspaceName));

    const displayName = label.split('\n')[0]?.trim() ?? label;
    const internalId = deriveTeamId({ workspaceUrl, displayName });

    if (teams.some((team) => team.internalId === internalId)) continue;

    teams.push({
      internalId,
      displayName,
      workspaceUrl,
      leaveSupportedState: 'unknown',
      discoveryTimestamp: now,
      isCurrent,
      isPersonal: looksPersonal(displayName),
    });
  }

  await dismissOverlay();

  if (teams.length === 0) {
    ctx.debug('Switcher opened but no workspace entries were recognised');
    return {
      teams: [],
      currentWorkspaceName,
      detail: `Switcher opened but no entries looked like workspaces. Rejected labels: ${
        rejected.join(' | ') || '(none)'
      }`,
    };
  }

  return {
    teams,
    currentWorkspaceName,
    detail: `Read ${teams.length} workspace entr(ies) from the switcher using candidate "${
      options[0]?.candidate.description ?? 'unknown'
    }".${rejected.length > 0 ? ` Ignored ${rejected.length} non-workspace entr(ies).` : ''}`,
  };
}

/**
 * Fallback workspace switch, used only when a team has no direct URL. The
 * preferred path is the background navigating the tab to the workspace URL that
 * discovery read from the switcher's own link.
 */
export async function switchWorkspace(ctx: ActionContext, team: Team): Promise<{ detail: string }> {
  assertNoInterruption();

  const trigger = await waitForSelector(SELECTORS.workspaceSwitcherTrigger, {
    ...ctx.wait('the workspace switcher control'),
  });
  await clickElement(trigger.element);
  await ctx.step();

  const menu = await waitForSelector(SELECTORS.workspaceSwitcherMenu, {
    ...ctx.wait('the workspace switcher to open', 'dialog_not_opened'),
  });

  const option = resolve(SELECTORS.workspaceOption, {
    root: menu.element,
    name: [team.displayName],
  });

  if (!option) {
    await dismissOverlay();
    throw new ActionError(
      'destination_not_found',
      `Workspace "${team.displayName}" was not listed in the switcher`,
      describeSpecFailure(SELECTORS.workspaceOption, { root: menu.element, name: [team.displayName] }),
    );
  }

  await clickElement(option.element);
  await ctx.step(2);

  return { detail: `Clicked switcher entry for "${team.displayName}"` };
}
