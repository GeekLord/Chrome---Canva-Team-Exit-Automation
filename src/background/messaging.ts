/**
 * Command surface for the popup and options page.
 *
 * Commands are validated before they reach the coordinator, and every command
 * that changes state answers with a fresh snapshot so the UI never has to guess.
 */

import { uiError, type UiCommand, type UiResponse } from '../shared/messages';

import type { CommandOutcome, RunCoordinator } from './run-coordinator';

async function respond(coordinator: RunCoordinator, outcome: CommandOutcome): Promise<UiResponse> {
  if (!outcome.ok) {
    return uiError(outcome.message ?? 'The command could not be completed.', outcome.category, outcome.nextStep ?? null);
  }
  return { ok: true, kind: 'snapshot', snapshot: await coordinator.snapshot(false) };
}

export async function handleUiCommand(coordinator: RunCoordinator, command: UiCommand): Promise<UiResponse> {
  switch (command.type) {
    case 'GET_SNAPSHOT':
      return { ok: true, kind: 'snapshot', snapshot: await coordinator.snapshot(true) };

    case 'GET_SETTINGS':
      return { ok: true, kind: 'settings', settings: coordinator.getSettings() };

    case 'UPDATE_SETTINGS':
      return { ok: true, kind: 'settings', settings: await coordinator.updateSettings(command.patch) };

    case 'RESET_SETTINGS':
      return { ok: true, kind: 'settings', settings: await coordinator.resetSettings() };

    case 'ACCEPT_DISCLOSURE':
      return { ok: true, kind: 'settings', settings: await coordinator.acceptDisclosure() };

    case 'SCAN_TEAMS':
      return await respond(coordinator, await coordinator.scanTeams());

    case 'SELECT_TEAMS':
      return await respond(coordinator, await coordinator.selectTeams(command.teamIds));

    case 'SELECT_DESTINATION':
      return await respond(coordinator, await coordinator.selectDestination(command.teamId));

    case 'SELECT_MODE':
      return await respond(coordinator, await coordinator.selectMode(command.mode));

    case 'SCAN_ITEMS':
      return await respond(coordinator, await coordinator.scanItems());

    case 'SET_ITEM_INCLUSION':
      return await respond(coordinator, await coordinator.setItemInclusion(command.itemId, command.selected));

    case 'SET_ALL_INCLUSIONS':
      return await respond(coordinator, await coordinator.setAllInclusions(command.selected, command.teamId));

    case 'GRANT_CONFIRMATION':
      return await respond(coordinator, await coordinator.grantConfirmation(command.scope));

    case 'REVOKE_CONFIRMATION':
      return await respond(coordinator, await coordinator.revokeConfirmation(command.scope));

    case 'CONFIRM_LEAVE':
      return await respond(coordinator, await coordinator.confirmLeave(command.teamId));

    case 'SKIP_LEAVE':
      return await respond(coordinator, await coordinator.skipLeave(command.teamId));

    case 'SET_OVERRIDES':
      return await respond(coordinator, await coordinator.setOverrides(command.overrides));

    case 'START_RUN':
      return await respond(coordinator, await coordinator.startRun());

    case 'PAUSE_RUN':
      return await respond(coordinator, await coordinator.pauseRun());

    case 'RESUME_RUN':
      return await respond(coordinator, await coordinator.resumeRun());

    case 'STOP_RUN':
      return await respond(coordinator, await coordinator.stopRun());

    case 'RETRY_ITEM':
      return await respond(coordinator, await coordinator.retryItem(command.itemId));

    case 'SKIP_ITEM':
      return await respond(
        coordinator,
        await coordinator.skipItem(command.itemId, command.reason ?? 'Skipped by operator'),
      );

    case 'RESOLVE_MANUAL_ASSIST':
      return await respond(coordinator, await coordinator.resolveManualAssist(command.itemId, command.outcome));

    case 'NEW_RUN':
      return await respond(coordinator, await coordinator.newRun());

    case 'GET_LOGS':
      return { ok: true, kind: 'logs', logs: await coordinator.getLogs(command.runId) };

    case 'PURGE_LOCAL_DATA':
      return await respond(coordinator, await coordinator.purgeLocalData());

    default: {
      const exhaustive: never = command;
      return uiError(`Unknown command: ${JSON.stringify(exhaustive)}`);
    }
  }
}
