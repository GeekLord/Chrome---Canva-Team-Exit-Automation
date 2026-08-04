/**
 * FR-5 copy playbook: copy one item to the destination workspace using Canva's
 * own "copy to another team" flow. One item at a time, never a bulk operation.
 */

import { ActionError } from '../../shared/errors';
import type { CopyItemResult } from '../../shared/messages';
import type { DesignItem, Destination } from '../../shared/types';
import {
  clickElement,
  describeSpecFailure,
  dismissOverlay,
  resolve,
  typeIntoField,
  waitForSelector,
  waitForValue,
} from '../dom-utils';
import { SELECTORS } from '../selector-map';
import { COPY_SUCCESS_PATTERN, FAILURE_PATTERN, findToast } from '../toasts';

import type { ActionContext } from './context';
import { assertMutationAllowed } from './context';
import { openItemMenu } from './item-menu';

export async function copyItem(
  ctx: ActionContext,
  item: DesignItem,
  destination: Destination,
): Promise<CopyItemResult> {
  assertMutationAllowed(ctx, 'copyItem');

  if (destination.kind !== 'sameLoginWorkspace') {
    throw new ActionError(
      'destination_not_found',
      'Only same-session workspace destinations are supported in this version',
      `destination.kind=${destination.kind}`,
    );
  }

  const { menu } = await openItemMenu(ctx, item);

  const copyEntry = resolve(SELECTORS.itemMenuCopyToTeam, { root: menu.element });
  if (!copyEntry) {
    await dismissOverlay();
    throw new ActionError(
      'copy_action_missing',
      `Canva did not offer a copy action for "${item.title}"`,
      describeSpecFailure(SELECTORS.itemMenuCopyToTeam, { root: menu.element }),
    );
  }

  ctx.debug(`Choosing copy action via ${copyEntry.candidate.description}`);
  await clickElement(copyEntry.element);
  await ctx.step();

  let dialog;
  try {
    dialog = await waitForSelector(SELECTORS.copyDialog, {
      ...ctx.wait('the copy destination dialog', 'dialog_not_opened'),
    });
  } catch (error) {
    await dismissOverlay();
    throw error;
  }

  try {
    // Narrow a long workspace list before looking for the destination row.
    const search = resolve(SELECTORS.copyDialogSearchInput, { root: dialog.element });
    if (search) {
      ctx.debug('Filtering the destination list');
      await typeIntoField(search.element, destination.displayName);
      await ctx.step();
    }

    const option = await waitForValue(
      () => resolve(SELECTORS.copyDialogDestinationOption, { root: dialog.element, name: [destination.displayName] }),
      ctx.wait(`destination "${destination.displayName}" in the copy dialog`, 'destination_not_found'),
    ).catch((error: unknown) => {
      throw error instanceof ActionError
        ? new ActionError(
            'destination_not_found',
            `Destination "${destination.displayName}" was not offered in the copy dialog`,
            describeSpecFailure(SELECTORS.copyDialogDestinationOption, {
              root: dialog.element,
              name: [destination.displayName],
            }),
          )
        : error;
    });

    await clickElement(option.element);
    await ctx.step();

    const confirm = resolve(SELECTORS.copyDialogConfirm, { root: dialog.element });
    if (confirm) {
      ctx.debug(`Confirming copy via ${confirm.candidate.description}`);
      await clickElement(confirm.element);
    } else {
      ctx.debug('No separate confirm control; selecting the destination performed the copy');
    }

    const outcome = await waitForValue(
      () => {
        const failure = findToast(FAILURE_PATTERN);
        if (failure) return { kind: 'failure' as const, text: failure };
        const success = findToast(COPY_SUCCESS_PATTERN);
        if (success) return { kind: 'toast' as const, text: success };
        if (!dialog.element.isConnected || resolve(SELECTORS.copyDialog) === null) {
          return { kind: 'dialogClosed' as const, text: '' };
        }
        return null;
      },
      ctx.wait('Canva to confirm the copy', 'copy_verification_failed'),
    );

    if (outcome.kind === 'failure') {
      throw new ActionError(
        'copy_verification_failed',
        `Canva reported a problem copying "${item.title}"`,
        `toast: ${outcome.text}`,
      );
    }

    const sawSuccessConfirmation = outcome.kind === 'toast';
    return {
      detail:
        outcome.kind === 'toast'
          ? `Canva confirmed the copy: "${outcome.text}"`
          : 'Copy dialog closed without an explicit confirmation message; verification will check the destination.',
      sawSuccessConfirmation,
    };
  } finally {
    // Never leave a dialog open for the next action to trip over.
    if (resolve(SELECTORS.copyDialog)) await dismissOverlay();
  }
}
