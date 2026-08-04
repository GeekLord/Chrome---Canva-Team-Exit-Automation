/**
 * Id helpers. `crypto.randomUUID` exists in the service worker, extension pages
 * and content scripts on the Chrome versions this extension targets; the
 * fallback only matters for non-secure test contexts.
 */

function randomSuffix(): string {
  const globalCrypto = globalThis.crypto as Crypto | undefined;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newRunId(): string {
  return `run_${randomSuffix()}`;
}

export function newEventId(): string {
  return `evt_${randomSuffix()}`;
}

/**
 * Stable id for a discovered item. Canva does not always expose a durable id in
 * the listing DOM, so the URL is preferred and the title+team pair is the
 * fallback. Stability matters because a resumed run has to recognise the same
 * item again after a page reload.
 */
export function deriveItemId(input: { sourceUrl: string | null; title: string; sourceTeamId: string }): string {
  if (input.sourceUrl) {
    const fromUrl = extractCanvaDesignId(input.sourceUrl);
    if (fromUrl) return `item_${fromUrl}`;
  }
  return `item_${simpleHash(`${input.sourceTeamId}::${input.title}`)}`;
}

/**
 * Canva design URLs look like `/design/DAF123abc/edit`. The middle segment is
 * the durable design id.
 */
export function extractCanvaDesignId(url: string): string | null {
  const match = /\/design\/([A-Za-z0-9_-]{6,})/.exec(url);
  return match?.[1] ?? null;
}

export function deriveTeamId(input: { workspaceUrl: string | null; displayName: string }): string {
  if (input.workspaceUrl) {
    const match = /\/(?:brand|team|folder)\/([A-Za-z0-9_-]{4,})/.exec(input.workspaceUrl);
    if (match?.[1]) return `team_${match[1]}`;
  }
  return `team_${simpleHash(input.displayName)}`;
}

/** Small non-cryptographic hash (FNV-1a) used only for local id derivation. */
export function simpleHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
