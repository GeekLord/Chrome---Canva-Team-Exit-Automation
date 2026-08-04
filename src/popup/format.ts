/** Display strings. Wording follows the project rule: copy and trash. */

import type { Tone } from './dom';
import type {
  ConfirmationScope,
  CopyCapability,
  DesignItem,
  ItemState,
  RunState,
  VerificationStatus,
} from '../shared/types';

export const RUN_STATE_LABELS: Record<RunState, string> = {
  idle: 'Not started',
  discoveringTeams: 'Scanning teams',
  selectingTeams: 'Choosing teams',
  discoveringItems: 'Scanning designs',
  reviewReady: 'Ready for review',
  awaitingStartConfirmation: 'Waiting for confirmation',
  copying: 'Copying',
  verifying: 'Verifying',
  trashing: 'Trashing originals',
  awaitingLeaveConfirmation: 'Waiting to leave team',
  leavingTeam: 'Leaving team',
  paused: 'Paused',
  completed: 'Completed',
  completedWithWarnings: 'Completed with warnings',
  failed: 'Failed',
  blocked: 'Blocked',
};

export const ITEM_STATE_LABELS: Record<ItemState, string> = {
  discovered: 'Found',
  selected: 'Included',
  copyPending: 'Queued to copy',
  copyInProgress: 'Copying',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  copyVerified: 'Copy verified',
  deletePending: 'Queued to trash',
  deleteInProgress: 'Trashing',
  deleteFailed: 'Trash failed',
  completed: 'Done',
  skipped: 'Skipped',
  manualReviewRequired: 'Needs review',
};

export function itemStateTone(state: ItemState): Tone {
  switch (state) {
    case 'completed':
    case 'copyVerified':
      return 'ok';
    case 'copyFailed':
    case 'deleteFailed':
      return 'error';
    case 'manualReviewRequired':
    case 'skipped':
      return 'warn';
    default:
      return 'plain';
  }
}

export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  unverified: 'not verified',
  strong: 'strong',
  weak: 'weak',
  manual: 'manual',
  failed: 'failed',
};

export const CAPABILITY_LABELS: Record<CopyCapability, string> = {
  available: 'copy available',
  unavailable: 'no copy action',
  unknown: 'not probed',
};

export function capabilityTone(capability: CopyCapability): Tone {
  if (capability === 'available') return 'ok';
  if (capability === 'unavailable') return 'error';
  return 'warn';
}

export const RISK_FLAG_LABELS: Record<DesignItem['riskFlags'][number], string> = {
  ownershipUnclear: 'owner unclear',
  copyActionUnknown: 'copy not probed',
  copyActionMissing: 'no copy action',
  sharedWithTeam: 'shared with team',
  itemTypeUnsupported: 'type not supported',
  duplicateTitleInDestination: 'duplicate title',
  titleEmpty: 'no title',
};

export const CONFIRMATION_LABELS: Record<ConfirmationScope, { label: string; detail: string }> = {
  liveExecution: {
    label: 'I understand this run will change my Canva content',
    detail: 'Copies will be made in the destination workspace.',
  },
  trash: {
    label: 'I approve moving verified originals to trash',
    detail: 'Only items with a verified copy are trashed, and only to Canva trash.',
  },
  leaveTeam: {
    label: 'I approve leaving the selected teams',
    detail: 'Each team also asks for a separate confirmation right before leaving.',
  },
  multiTeamBatch: {
    label: 'I approve processing more than one team in this batch',
    detail: 'Teams are processed one at a time, in order.',
  },
  largeBatch: {
    label: 'I approve a large batch',
    detail: 'This run is above the item threshold set in Options.',
  },
};

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function truncate(value: string, max = 70): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
