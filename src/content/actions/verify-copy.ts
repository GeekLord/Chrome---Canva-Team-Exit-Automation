/**
 * FR-6 copy verification, destination-listing strategy.
 *
 * This runs with the tab already on the destination workspace's project listing.
 * It can only ever return `weak`: a title match proves something with that name
 * exists in the destination, not that it is byte-identical to the original.
 * `strong` verification comes from Canva's own confirmation during the copy and
 * is recorded by the engine without calling this action.
 */

import { ActionError } from '../../shared/errors';
import type { VerifyCopyResult } from '../../shared/messages';
import type { DesignItem, Destination } from '../../shared/types';
import { assertNoInterruption } from '../detect';
import { scrollableAncestor, scrollToBottom, sleep, waitForSelector } from '../dom-utils';
import { findCardByTitle } from '../item-cards';
import { SELECTORS } from '../selector-map';

import type { ActionContext } from './context';

/** Scroll passes allowed while hunting for the copied item. */
const MAX_SEARCH_ROUNDS = 12;

export async function verifyCopy(
  ctx: ActionContext,
  item: DesignItem,
  destination: Destination,
): Promise<VerifyCopyResult> {
  assertNoInterruption();

  const grid = await waitForSelector(SELECTORS.projectGrid, {
    ...ctx.wait(`the project listing in "${destination.displayName}"`),
  });

  for (let round = 1; round <= MAX_SEARCH_ROUNDS && !ctx.deadline.expired; round += 1) {
    assertNoInterruption();

    const found = findCardByTitle(item.title);
    if (found) {
      return {
        level: 'weak',
        detail: found.exact
          ? `Exact title match "${found.card.title}" found in "${destination.displayName}" after ${round} pass(es)`
          : `Near title match "${found.card.title}" found in "${destination.displayName}" after ${round} pass(es)`,
      };
    }

    scrollToBottom(scrollableAncestor(grid.element));
    await sleep(Math.min(600, Math.max(150, ctx.deadline.remainingMs)));
  }

  throw new ActionError(
    'copy_verification_failed',
    `Could not find "${item.title}" in "${destination.displayName}"`,
    `Searched the destination listing for up to ${MAX_SEARCH_ROUNDS} scroll passes. The original has been left in place.`,
  );
}
