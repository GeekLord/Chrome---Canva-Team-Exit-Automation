/**
 * FR-7 trash playbook: move the original to Canva's trash.
 *
 * Move to Trash only. Permanent deletion is deliberately not automated, so a
 * mistake stays recoverable from Canva's own trash.
 *
 * The engine guarantees this is only reached for an item whose copy is verified
 * (or explicitly overridden by the operator).
 */

import { ActionError } from '../../shared/errors';
import type { SimpleActionResult } from '../../shared/messages';
import type { DesignItem } from '../../shared/types';
import {
  clickElement,
  describeSpecFailure,
  dismissOverlay,
  resolve,
  waitForValue,
} from '../dom-utils';
import { findCardForItem } from '../item-cards';
import { SELECTORS } from '../selector-map';
import { FAILURE_PATTERN, findToast, TRASH_SUCCESS_PATTERN } from '../toasts';

import type { ActionContext } from './context';
import { assertMutationAllowed } from './context';
import { openItemMenu } from './item-menu';

export async function trashItem(ctx: ActionContext, item: DesignItem): Promise<SimpleActionResult> {
  assertMutationAllowed(ctx, 'trashItem');

  const { menu } = await openItemMenu(ctx, item);

  const trashEntry = resolve(SELECTORS.itemMenuMoveToTrash, { root: menu.element });
  if (!trashEntry) {
    await dismissOverlay();
    throw new ActionError(
      'delete_action_missing',
      `Canva did not offer a move-to-trash action for "${item.title}"`,
      describeSpecFailure(SELECTORS.itemMenuMoveToTrash, { root: menu.element }),
    );
  }

  ctx.debug(`Choosing trash action via ${trashEntry.candidate.description}`);
  await clickElement(trashEntry.element);
  await ctx.step();

  // Canva may or may not ask for confirmation depending on item type.
  const confirmDialog = resolve(SELECTORS.confirmDialog);
  if (confirmDialog) {
    const confirmButton = resolve(SELECTORS.confirmDialogTrashButton, { root: confirmDialog.element });
    if (!confirmButton) {
      await dismissOverlay();
      throw new ActionError(
        'delete_failed',
        `A confirmation dialog appeared for "${item.title}" but no confirm control was found`,
        describeSpecFailure(SELECTORS.confirmDialogTrashButton, { root: confirmDialog.element }),
      );
    }
    ctx.debug(`Confirming trash via ${confirmButton.candidate.description}`);
    await clickElement(confirmButton.element);
  }

  const outcome = await waitForValue(
    () => {
      const failure = findToast(FAILURE_PATTERN);
      if (failure) return { kind: 'failure' as const, text: failure };
      const success = findToast(TRASH_SUCCESS_PATTERN);
      if (success) return { kind: 'toast' as const, text: success };
      if (findCardForItem(item) === null) return { kind: 'cardGone' as const, text: '' };
      return null;
    },
    ctx.wait(`"${item.title}" to leave the source listing`, 'delete_failed'),
  );

  if (outcome.kind === 'failure') {
    throw new ActionError(
      'delete_failed',
      `Canva reported a problem trashing "${item.title}"`,
      `toast: ${outcome.text}`,
    );
  }

  if (resolve(SELECTORS.confirmDialog)) await dismissOverlay();

  return {
    detail:
      outcome.kind === 'toast'
        ? `Canva confirmed the move to trash: "${outcome.text}"`
        : 'The item is no longer listed in the source team.',
  };
}
