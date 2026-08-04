/**
 * FR-8 team exit playbook.
 *
 * Runs with the tab already on the Canva settings view that exposes the leave
 * control. Admins can restrict who may leave a team, so a policy block is a
 * first-class outcome here, not an error to retry.
 */

import { ActionError } from '../../shared/errors';
import type { SimpleActionResult } from '../../shared/messages';
import type { Team } from '../../shared/types';
import { assertNoInterruption } from '../detect';
import {
  clickElement,
  describeSpecFailure,
  rawText,
  resolve,
  waitForValue,
} from '../dom-utils';
import { SELECTORS } from '../selector-map';
import { FAILURE_PATTERN, findToast, LEAVE_SUCCESS_PATTERN } from '../toasts';

import type { ActionContext } from './context';
import { assertMutationAllowed } from './context';

function readBlockedNotice(root?: ParentNode): string | null {
  const match = resolve(SELECTORS.teamLeaveBlockedNotice, root ? { root } : {});
  return match ? rawText(match.element).slice(0, 300) : null;
}

export async function leaveTeam(ctx: ActionContext, team: Team): Promise<SimpleActionResult> {
  assertMutationAllowed(ctx, 'leaveTeam');
  assertNoInterruption();

  const upfrontBlock = readBlockedNotice();
  if (upfrontBlock) {
    throw new ActionError(
      'leave_blocked_by_policy',
      `Canva says you cannot leave "${team.displayName}"`,
      `notice: ${upfrontBlock}`,
    );
  }

  const control = resolve(SELECTORS.teamSettingsLeaveControl);
  if (!control) {
    throw new ActionError(
      'selector_not_found',
      `No leave control was found for "${team.displayName}"`,
      `${describeSpecFailure(SELECTORS.teamSettingsLeaveControl)}\nurl=${location.href}`,
    );
  }

  ctx.debug(`Starting leave flow via ${control.candidate.description}`);
  await clickElement(control.element);
  await ctx.step();

  const dialog = resolve(SELECTORS.confirmDialog);
  if (dialog) {
    const blockedInDialog = readBlockedNotice(dialog.element);
    if (blockedInDialog) {
      throw new ActionError(
        'leave_blocked_by_policy',
        `Canva blocked leaving "${team.displayName}"`,
        `notice: ${blockedInDialog}`,
      );
    }

    const confirmButton = resolve(SELECTORS.teamLeaveConfirmButton, { root: dialog.element });
    if (!confirmButton) {
      throw new ActionError(
        'selector_not_found',
        `The leave confirmation dialog for "${team.displayName}" had no confirm control`,
        describeSpecFailure(SELECTORS.teamLeaveConfirmButton, { root: dialog.element }),
      );
    }

    ctx.debug(`Confirming leave via ${confirmButton.candidate.description}`);
    await clickElement(confirmButton.element);
  } else {
    ctx.debug('No confirmation dialog appeared after the leave control was clicked');
  }

  const outcome = await waitForValue(
    () => {
      const blocked = readBlockedNotice();
      if (blocked) return { kind: 'blocked' as const, text: blocked };
      const failure = findToast(FAILURE_PATTERN);
      if (failure) return { kind: 'failure' as const, text: failure };
      const success = findToast(LEAVE_SUCCESS_PATTERN);
      if (success) return { kind: 'toast' as const, text: success };
      if (resolve(SELECTORS.teamSettingsLeaveControl) === null) return { kind: 'controlGone' as const, text: '' };
      return null;
    },
    ctx.wait(`Canva to confirm leaving "${team.displayName}"`, 'leave_blocked_by_policy'),
  );

  if (outcome.kind === 'blocked') {
    throw new ActionError(
      'leave_blocked_by_policy',
      `Canva blocked leaving "${team.displayName}"`,
      `notice: ${outcome.text}`,
    );
  }
  if (outcome.kind === 'failure') {
    throw new ActionError(
      'leave_blocked_by_policy',
      `Canva reported a problem leaving "${team.displayName}"`,
      `message: ${outcome.text}`,
    );
  }

  return {
    detail:
      outcome.kind === 'toast'
        ? `Canva confirmed the exit: "${outcome.text}"`
        : 'The leave control is no longer present, which indicates the team was left.',
  };
}
