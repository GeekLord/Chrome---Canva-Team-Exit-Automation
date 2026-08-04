/**
 * FR-3 item discovery: enumerate the design cards in the current listing,
 * driving Canva's lazy-loading list until it stops growing.
 *
 * Non-mutating. Ownership filtering only happens where Canva actually exposes
 * owner information; when it does not, items are listed with an
 * `ownershipUnclear` flag and left unchecked so the operator decides.
 */

import { createDesignItem } from '../../shared/factories';
import type { DiscoverItemsResult } from '../../shared/messages';
import type { DesignItem } from '../../shared/types';
import { assertNoInterruption } from '../detect';
import {
  clickElement,
  resolve,
  scrollableAncestor,
  scrollToBottom,
  sleep,
  waitForSelector,
} from '../dom-utils';
import { collectItemCards, type ItemCard } from '../item-cards';
import { SELECTORS } from '../selector-map';

import type { ActionContext } from './context';

/** Upper bound so a pathological list cannot exhaust memory. */
const MAX_ITEMS = 2000;

/** Rounds with no new cards before discovery calls the list complete. */
const STABLE_ROUNDS_REQUIRED = 3;

export interface DiscoverItemsInput {
  teamId: string;
  requireOwnedByMe: boolean;
}

function cardKey(card: ItemCard): string {
  return card.designId ?? `title:${card.title.toLowerCase()}`;
}

export async function discoverItems(ctx: ActionContext, input: DiscoverItemsInput): Promise<DiscoverItemsResult> {
  assertNoInterruption();

  const grid = await waitForSelector(SELECTORS.projectGrid, {
    ...ctx.wait('the Canva project listing to render'),
  });

  const collected = new Map<string, ItemCard>();
  let stableRounds = 0;
  let rounds = 0;

  while (stableRounds < STABLE_ROUNDS_REQUIRED && !ctx.deadline.expired && collected.size < MAX_ITEMS) {
    rounds += 1;
    assertNoInterruption();

    const before = collected.size;
    for (const card of collectItemCards()) {
      collected.set(cardKey(card), card);
      if (collected.size >= MAX_ITEMS) break;
    }
    stableRounds = collected.size === before ? stableRounds + 1 : 0;

    ctx.debug(`Discovery round ${rounds}: ${collected.size} item(s) so far`);

    const loadMore = resolve(SELECTORS.listScrollSentinel);
    if (loadMore && loadMore.candidate.strategy === 'text') {
      await clickElement(loadMore.element);
    } else {
      scrollToBottom(scrollableAncestor(grid.element));
    }

    await sleep(Math.min(700, Math.max(200, ctx.deadline.remainingMs)));
  }

  const now = new Date().toISOString();
  const items: DesignItem[] = [...collected.values()].map((card) => {
    const isFolder = card.itemType === 'folder';
    const ownedByMe = card.ownerConfidence === 'high';
    return createDesignItem({
      title: card.title,
      sourceUrl: card.url,
      sourceTeamId: input.teamId,
      now,
      itemType: card.itemType,
      ownerLabel: card.ownerLabel,
      ownerConfidence: card.ownerConfidence,
      // Folder-level migration is a deferred feature, so folders start excluded.
      selected: isFolder ? false : input.requireOwnedByMe ? ownedByMe : true,
      riskFlags: [...(isFolder ? (['itemTypeUnsupported'] as const) : []), 'copyActionUnknown'],
    });
  });

  const truncated = ctx.deadline.expired || collected.size >= MAX_ITEMS;
  const unclear = items.filter((item) => item.ownerConfidence !== 'high').length;

  return {
    items,
    truncated,
    detail: [
      `Scanned ${rounds} round(s) and found ${items.length} item(s).`,
      truncated ? 'Discovery stopped early on the timeout or item cap, so the list may be incomplete.' : null,
      unclear > 0
        ? `${unclear} item(s) had no clear owner label; they are listed but unchecked when "owned by me" filtering is on.`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' '),
  };
}
