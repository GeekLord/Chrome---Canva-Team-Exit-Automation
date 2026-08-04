/**
 * Manual-assist highlighting.
 *
 * When automation confidence is low the engine stops and asks the operator to do
 * one step by hand. This draws a ring around the item in question and states the
 * next step in a live region, without modifying any of Canva's own nodes.
 */

import type { DesignItem } from '../shared/types';

import { findCardForItem } from './item-cards';

const HOST_ID = 'canva-team-exit-automation-assist';

interface ActiveHighlight {
  host: HTMLElement;
  ring: HTMLElement;
  target: HTMLElement;
  reposition: () => void;
}

let active: ActiveHighlight | null = null;

function buildHost(): { host: HTMLElement; ring: HTMLElement; banner: HTMLElement } {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483646';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .ring {
      position: fixed;
      border: 3px solid #b23c17;
      border-radius: 10px;
      box-shadow: 0 0 0 3px rgba(178, 60, 23, 0.25);
      transition: top 80ms linear, left 80ms linear;
      pointer-events: none;
    }
    .banner {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      max-width: min(680px, 92vw);
      background: #10161c;
      color: #f6f7f9;
      font: 500 13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif;
      padding: 12px 16px;
      border-radius: 10px;
      border: 1px solid #3a4652;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
      pointer-events: none;
    }
    .banner strong { display: block; margin-bottom: 4px; color: #ffd9a0; }
  `;

  const ring = document.createElement('div');
  ring.className = 'ring';

  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  shadow.append(style, ring, banner);
  return { host, ring, banner };
}

function positionRing(ring: HTMLElement, target: HTMLElement): void {
  const rect = target.getBoundingClientRect();
  ring.style.top = `${Math.max(0, rect.top - 4)}px`;
  ring.style.left = `${Math.max(0, rect.left - 4)}px`;
  ring.style.width = `${rect.width + 8}px`;
  ring.style.height = `${rect.height + 8}px`;
}

export interface HighlightResult {
  located: boolean;
  detail: string;
}

export function highlightItem(item: DesignItem, instruction: string): HighlightResult {
  clearHighlight();

  const card = findCardForItem(item);
  const { host, ring, banner } = buildHost();

  banner.innerHTML = '';
  const heading = document.createElement('strong');
  heading.textContent = 'Manual step needed';
  const body = document.createElement('span');
  body.textContent = card
    ? `${instruction} Then confirm in the extension popup.`
    : `${instruction} The item could not be located on this page, so nothing is highlighted. Confirm in the extension popup when done.`;
  banner.append(heading, body);

  document.body.appendChild(host);

  if (!card) {
    ring.style.display = 'none';
    active = { host, ring, target: document.body, reposition: () => undefined };
    return { located: false, detail: `Could not locate a card for "${item.title}"` };
  }

  const target = card.root;
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  positionRing(ring, target);

  const reposition = (): void => positionRing(ring, target);
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });

  active = { host, ring, target, reposition };
  return { located: true, detail: `Highlighted "${card.title}"` };
}

export function clearHighlight(): void {
  if (!active) {
    document.getElementById(HOST_ID)?.remove();
    return;
  }
  window.removeEventListener('scroll', active.reposition, { capture: true });
  window.removeEventListener('resize', active.reposition);
  active.host.remove();
  active = null;
}
