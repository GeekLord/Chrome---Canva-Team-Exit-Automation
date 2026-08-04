/**
 * Thin client for talking to the background engine.
 *
 * Every command answers with either a snapshot, settings, logs or a normalized
 * error, so UI code never has to interpret a raw failure.
 */

import type { RunSnapshot, UiCommand, UiResponse } from '../shared/messages';
import type { LogEvent, Settings } from '../shared/types';

export type CommandResult = UiResponse;

export async function send(command: UiCommand): Promise<CommandResult> {
  try {
    const response = (await chrome.runtime.sendMessage(command)) as UiResponse | undefined;
    if (!response) {
      return {
        ok: false,
        kind: 'error',
        message: 'The extension background worker did not answer.',
        category: 'unknown',
        nextStep: 'Close and reopen the popup. If it keeps happening, reload the extension.',
      };
    }
    return response;
  } catch (error) {
    return {
      ok: false,
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      category: 'unknown',
      nextStep: 'Reload the extension from chrome://extensions and try again.',
    };
  }
}

export async function fetchSnapshot(): Promise<RunSnapshot | null> {
  const response = await send({ type: 'GET_SNAPSHOT' });
  return response.ok && response.kind === 'snapshot' ? response.snapshot : null;
}

export async function fetchSettings(): Promise<Settings | null> {
  const response = await send({ type: 'GET_SETTINGS' });
  return response.ok && response.kind === 'settings' ? response.settings : null;
}

export async function fetchLogs(runId?: string): Promise<LogEvent[]> {
  const response = await send(runId ? { type: 'GET_LOGS', runId } : { type: 'GET_LOGS' });
  return response.ok && response.kind === 'logs' ? response.logs : [];
}

export interface BroadcastHandlers {
  onSnapshot(snapshot: RunSnapshot): void;
  onAttention?(message: string): void;
}

/**
 * Subscribes to background broadcasts.
 *
 * The payload comes from this extension's own service worker, so it is shape-
 * checked rather than fully re-validated; the background already validated
 * everything that entered the state machine.
 */
export function subscribe(handlers: BroadcastHandlers): void {
  chrome.runtime.onMessage.addListener((raw, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) return;

    const message = raw as { type: string; snapshot?: unknown; message?: unknown };
    if (message.type === 'SNAPSHOT_UPDATED' && isSnapshotLike(message.snapshot)) {
      handlers.onSnapshot(message.snapshot);
      return;
    }
    if (message.type === 'RUN_ATTENTION' && typeof message.message === 'string') {
      handlers.onAttention?.(message.message);
    }
  });
}

function isSnapshotLike(value: unknown): value is RunSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RunSnapshot>;
  return (
    typeof candidate.job === 'object' &&
    candidate.job !== null &&
    typeof candidate.settings === 'object' &&
    candidate.settings !== null &&
    typeof candidate.page === 'object' &&
    candidate.page !== null
  );
}
