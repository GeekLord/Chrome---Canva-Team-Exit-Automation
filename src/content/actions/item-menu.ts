/**
 * Opening a card's action menu is the first half of both the copy and the trash
 * playbooks, so it lives here once.
 */

import { ActionError } from '../../shared/errors';
import type { DesignItem } from '../../shared/types';
import { assertNoInterruption } from '../detect';
import { clickElement, describeSpecFailure, dismissOverlay, waitForSelector, type SelectorMatch } from '../dom-utils';
import { cardMenuTrigger, describeCard, findCardForItem, type ItemCard } from '../item-cards';
import { SELECTORS } from '../selector-map';

import type { ActionContext } from './context';

export interface OpenItemMenuResult {
  card: ItemCard;
  menu: SelectorMatch;
}

export function locateCardOrThrow(item: DesignItem): ItemCard {
  const card = findCardForItem(item);
  if (card) return card;
  throw new ActionError(
    'selector_not_found',
    `Could not find "${item.title}" in the current listing`,
    describeSpecFailure(SELECTORS.projectItemCard),
  );
}

export async function openItemMenu(ctx: ActionContext, item: DesignItem): Promise<OpenItemMenuResult> {
  assertNoInterruption();

  const card = locateCardOrThrow(item);
  const trigger = cardMenuTrigger(card);
  if (!trigger) {
    throw new ActionError(
      'selector_not_found',
      `No action menu control on the card for "${item.title}"`,
      `${describeCard(card)}\n${describeSpecFailure(SELECTORS.projectItemMenuTrigger, { root: card.root })}`,
    );
  }

  ctx.debug(`Opening item menu for "${card.title}"`, describeCard(card));
  await clickElement(trigger);
  await ctx.step();

  try {
    const menu = await waitForSelector(SELECTORS.itemMenu, {
      ...ctx.wait(`the action menu for "${item.title}"`, 'dialog_not_opened'),
    });
    return { card, menu };
  } catch (error) {
    await dismissOverlay();
    throw error;
  }
}
