/**
 * Reading the Canva project listing.
 *
 * Cards are identified by the design id in their link where possible, because
 * that survives re-renders and virtual scrolling. Title matching is the fallback
 * and is treated as weaker evidence everywhere it is used.
 */

import { extractCanvaDesignId } from '../shared/ids';
import type { DesignItem, ItemType, OwnerConfidence } from '../shared/types';

import { accessibleName, closestClickable, rawText, resolve, resolveAll, normalizeText } from './dom-utils';
import { SELECTORS } from './selector-map';

export interface ItemCard {
  root: HTMLElement;
  title: string;
  url: string | null;
  designId: string | null;
  ownerLabel: string | null;
  ownerConfidence: OwnerConfidence;
  itemType: ItemType;
}

/** Entries in the listing that are controls, not designs. */
const NON_ITEM_TEXT = [
  'create a design',
  'create new',
  'new design',
  'add new',
  'upload',
  'see all',
  'show all',
  'load more',
];

function looksLikeControl(text: string): boolean {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return true;
  return NON_ITEM_TEXT.some((candidate) => normalized === candidate || normalized.startsWith(candidate));
}

function extractTitle(card: HTMLElement): string {
  const link = resolve(SELECTORS.projectItemLink, { root: card });
  if (link) {
    const aria = link.element.getAttribute('aria-label');
    if (aria && aria.trim().length > 0) return aria.trim();
    const title = link.element.getAttribute('title');
    if (title && title.trim().length > 0) return title.trim();
  }

  const heading = resolve(SELECTORS.projectItemTitle, { root: card });
  if (heading) {
    const attr = heading.element.getAttribute('title') ?? heading.element.getAttribute('aria-label');
    if (attr && attr.trim().length > 0) return attr.trim();
    const text = rawText(heading.element);
    if (text.length > 0) return text;
  }

  // Last resort: the first line of the card's own text.
  const firstLine = rawText(card).split(/[\n·|]/)[0]?.trim() ?? '';
  return firstLine;
}

function extractUrl(card: HTMLElement): string | null {
  const link = resolve(SELECTORS.projectItemLink, { root: card });
  if (link && link.element instanceof HTMLAnchorElement) return link.element.href;
  if (card instanceof HTMLAnchorElement) return card.href;
  return null;
}

function extractOwner(card: HTMLElement): { label: string | null; confidence: OwnerConfidence } {
  const match = resolve(SELECTORS.projectItemOwnerLabel, { root: card });
  if (!match) return { label: null, confidence: 'unknown' };

  const label = rawText(match.element);
  const normalized = normalizeText(label);
  if (normalized.length === 0) return { label: null, confidence: 'unknown' };

  // Canva shows "You" (or "Owned by you") on items the signed-in user owns.
  if (/\byou\b|\byour\b/.test(normalized)) return { label, confidence: 'high' };
  return { label, confidence: 'low' };
}

function extractItemType(card: HTMLElement, url: string | null): ItemType {
  if (url && url.includes('/design/')) return 'design';
  if (url && url.includes('/folder/')) return 'folder';
  const text = normalizeText(rawText(card));
  if (text.includes('folder')) return 'folder';
  return 'unknown';
}

export function collectItemCards(): ItemCard[] {
  const matches = resolveAll(SELECTORS.projectItemCard);
  const byKey = new Map<string, ItemCard>();

  for (const match of matches) {
    const root = match.element;
    const url = extractUrl(root);
    const designId = url ? extractCanvaDesignId(url) : null;
    const title = extractTitle(root);

    if (looksLikeControl(title) && !designId) continue;

    const owner = extractOwner(root);
    const key = designId ?? `title:${normalizeText(title)}`;
    if (key === 'title:') continue;

    // Keep the outermost card for a given design: it contains the action menu.
    const existing = byKey.get(key);
    if (existing && existing.root.contains(root)) continue;

    byKey.set(key, {
      root,
      title,
      url,
      designId,
      ownerLabel: owner.label,
      ownerConfidence: owner.confidence,
      itemType: extractItemType(root, url),
    });
  }

  return [...byKey.values()];
}

export function findCardForItem(item: DesignItem): ItemCard | null {
  const cards = collectItemCards();
  const wantedId = item.sourceUrl ? extractCanvaDesignId(item.sourceUrl) : null;

  if (wantedId) {
    const byId = cards.find((card) => card.designId === wantedId);
    if (byId) return byId;
  }

  const wantedTitle = normalizeText(item.title);
  const exact = cards.find((card) => normalizeText(card.title) === wantedTitle);
  if (exact) return exact;

  return null;
}

/** True when the destination listing contains something matching this title. */
export function findCardByTitle(title: string): { card: ItemCard; exact: boolean } | null {
  const cards = collectItemCards();
  const wanted = normalizeText(title);
  if (wanted.length === 0) return null;

  const exact = cards.find((card) => normalizeText(card.title) === wanted);
  if (exact) return { card: exact, exact: true };

  const partial = cards.find((card) => {
    const candidate = normalizeText(card.title);
    return candidate.includes(wanted) || wanted.includes(candidate);
  });
  return partial ? { card: partial, exact: false } : null;
}

/** The overflow control that opens the card's action menu. */
export function cardMenuTrigger(card: ItemCard): HTMLElement | null {
  const match = resolve(SELECTORS.projectItemMenuTrigger, {
    root: card.root,
    // The card's own link is not a menu trigger.
    reject: (element) => element instanceof HTMLAnchorElement,
  });
  if (!match) return null;
  return closestClickable(match.element) ?? match.element;
}

export function describeCard(card: ItemCard): string {
  return [
    `title="${card.title}"`,
    card.designId ? `designId=${card.designId}` : null,
    card.ownerLabel ? `owner="${card.ownerLabel}" (${card.ownerConfidence})` : `owner=unknown`,
    `menuTriggerName="${cardMenuTrigger(card) ? accessibleName(cardMenuTrigger(card) as HTMLElement) : 'none'}"`,
  ]
    .filter((part): part is string => part !== null)
    .join('; ');
}
