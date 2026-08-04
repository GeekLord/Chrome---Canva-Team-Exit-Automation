/**
 * MV3 service worker: wiring only.
 *
 * All behaviour lives in the coordinator, the reducer and the guards. This file
 * assembles them, owns the message listener, and keeps a single bootstrap promise
 * so an event that wakes the worker cannot race ahead of state recovery.
 */

import { chromeLocalStorage, LogStore } from '../logging/log-store';
import { formatLogLine } from '../logging/log-event';
import { parseUiCommand, uiError, type BroadcastMessage, type UiResponse } from '../shared/messages';
import { DEFAULT_SETTINGS } from '../shared/settings';

import { handleUiCommand } from './messaging';
import { RunCoordinator } from './run-coordinator';
import { ExtensionStore } from './storage';
import { TabController } from './tab-controller';

const storage = chromeLocalStorage();
const store = new ExtensionStore(storage);
const logs = new LogStore(storage, { maxEventsPerRun: DEFAULT_SETTINGS.logRetentionMaxEvents });
const tabs = new TabController();

function publish(message: BroadcastMessage): void {
  // No open popup or options page is the normal case; ignore the resulting error.
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

const coordinator = new RunCoordinator(store, logs, tabs, publish);

/** Mirrors events to the worker console when debug mode is on. */
logs.setOptions({
  maxEventsPerRun: DEFAULT_SETTINGS.logRetentionMaxEvents,
  onEvent: (event) => {
    if (coordinator.getSettings().debugMode) {
      console.debug(`[canva-team-exit] ${formatLogLine(event)}`);
    }
  },
});

const bootstrap: Promise<void> = coordinator.init().catch((error: unknown) => {
  console.error('[canva-team-exit] initialisation failed', error);
});

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await bootstrap;
    if (details.reason === 'install') {
      // Persist defaults so the Options page reflects real stored values, and so
      // a fresh profile starts in dry-run mode with live execution off.
      await store.saveSettings(DEFAULT_SETTINGS);
    }
  })();
});

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  // Only accept commands from this extension's own pages.
  if (sender.id !== chrome.runtime.id) return false;

  const command = parseUiCommand(raw);
  if (!command) return false;

  void (async () => {
    try {
      await bootstrap;
      const response = await handleUiCommand(coordinator, command);
      sendResponse(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[canva-team-exit] command failed', command.type, error);
      sendResponse(uiError(`${command.type} failed: ${message}`) satisfies UiResponse);
    }
  })();

  // Keep the channel open for the async response.
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.forget(tabId);
});
