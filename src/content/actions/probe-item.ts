/**
 * FR-4 capability probe.
 *
 * Opens the item's own action menu, reads which actions Canva offers, and closes
 * the menu again. Nothing is clicked beyond opening and dismissing a menu, so
 * this is safe to run in dry-run mode.
 */

import type { ProbeItemResult } from '../../shared/messages';
import type { DesignItem } from '../../shared/types';
import { dismissOverlay, rawText, resolve } from '../dom-utils';
import { SELECTORS } from '../selector-map';

import type { ActionContext } from './context';
import { openItemMenu } from './item-menu';

export async function probeItem(ctx: ActionContext, item: DesignItem): Promise<ProbeItemResult> {
  const { menu } = await openItemMenu(ctx, item);

  const copyEntry = resolve(SELECTORS.itemMenuCopyToTeam, { root: menu.element });
  const trashEntry = resolve(SELECTORS.itemMenuMoveToTrash, { root: menu.element });
  const menuText = rawText(menu.element).slice(0, 400);

  await dismissOverlay();

  return {
    capability: copyEntry ? 'available' : 'unavailable',
    detail: [
      copyEntry ? `copy entry via ${copyEntry.candidate.description}` : 'no copy entry found',
      trashEntry ? `trash entry via ${trashEntry.candidate.description}` : 'no trash entry found',
      `menu text: ${menuText}`,
    ].join('; '),
  };
}
