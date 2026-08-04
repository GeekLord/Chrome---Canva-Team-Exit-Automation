/**
 * End-of-run report derivation. Pure, so the popup, the options page and the
 * export all show exactly the same numbers.
 */

import type { NormalizedError } from './errors';
import { itemsForTeam } from './factories';
import { blockingItems } from './guards';
import type { ExecutionMode, LeaveSupportState, RunJob, VerificationStatus } from './types';

export interface ReportTeamRow {
  teamId: string;
  displayName: string;
  itemsSelected: number;
  copied: number;
  verified: number;
  trashed: number;
  left: boolean;
  leaveState: LeaveSupportState;
  unresolved: number;
}

export interface ReportBlockingIssue {
  itemId: string;
  title: string;
  teamName: string;
  state: string;
  category: string | null;
  message: string;
  nextStep: string | null;
}

export interface RunReport {
  runId: string;
  mode: ExecutionMode;
  state: RunJob['state'];
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  destination: string | null;
  teamsSelected: number;
  teamsProcessed: number;
  teamsLeft: number;
  itemsFound: number;
  itemsSelected: number;
  copied: number;
  verified: number;
  trashed: number;
  failed: number;
  skipped: number;
  manualReview: number;
  verificationBreakdown: Record<VerificationStatus, number>;
  teams: ReportTeamRow[];
  blockingIssues: ReportBlockingIssue[];
  blocker: NormalizedError | null;
  overrides: RunJob['userOverrides'];
  selectorMapVersion: string;
}

export function buildRunReport(job: RunJob): RunReport {
  const verificationBreakdown: Record<VerificationStatus, number> = {
    unverified: 0,
    strong: 0,
    weak: 0,
    manual: 0,
    failed: 0,
  };
  for (const item of job.items) {
    if (!item.selected) continue;
    verificationBreakdown[item.verificationStatus] += 1;
  }

  const teams: ReportTeamRow[] = job.sourceTeams.map((team) => {
    const items = itemsForTeam(job, team.internalId).filter((item) => item.selected);
    return {
      teamId: team.internalId,
      displayName: team.displayName,
      itemsSelected: items.length,
      copied: items.filter((item) => item.copyStatus === 'copied').length,
      verified: items.filter(
        (item) =>
          item.verificationStatus === 'strong' ||
          item.verificationStatus === 'weak' ||
          item.verificationStatus === 'manual',
      ).length,
      trashed: items.filter((item) => item.deleteStatus === 'trashed').length,
      left: job.leftTeamIds.includes(team.internalId),
      leaveState: team.leaveSupportedState,
      unresolved: items.filter((item) => item.state !== 'completed' && item.state !== 'skipped').length,
    };
  });

  const blockingIssues: ReportBlockingIssue[] = blockingItems(job).map((item) => ({
    itemId: item.internalId,
    title: item.title,
    teamName: job.sourceTeams.find((team) => team.internalId === item.sourceTeamId)?.displayName ?? item.sourceTeamId,
    state: item.state,
    category: item.lastError?.category ?? null,
    message: item.lastError?.message ?? 'Unresolved',
    nextStep: item.lastError?.nextStep ?? null,
  }));

  const durationMs =
    job.startedAt && job.endedAt ? new Date(job.endedAt).getTime() - new Date(job.startedAt).getTime() : null;

  return {
    runId: job.runId,
    mode: job.mode,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    durationMs: durationMs !== null && Number.isFinite(durationMs) ? durationMs : null,
    destination: job.destination?.displayName ?? null,
    teamsSelected: job.counters.teamsSelected,
    teamsProcessed: job.counters.teamsProcessed,
    teamsLeft: job.counters.teamsLeft,
    itemsFound: job.counters.itemsFound,
    itemsSelected: job.counters.itemsSelected,
    copied: job.counters.copied,
    verified: job.counters.verified,
    trashed: job.counters.trashed,
    failed: job.counters.failed,
    skipped: job.counters.skipped,
    manualReview: job.counters.manualReview,
    verificationBreakdown,
    teams,
    blockingIssues,
    blocker: job.blocker,
    overrides: job.userOverrides,
    selectorMapVersion: job.settings.selectorMapVersion,
  };
}

/**
 * Dry-run summary counts: what the engine thinks it could do, before anything
 * has been changed.
 */
export interface DryRunSummary {
  totalFound: number;
  selected: number;
  copyable: number;
  blocked: number;
  ambiguous: number;
  byTeam: Array<{ teamId: string; displayName: string; found: number; selected: number; copyable: number }>;
}

export function buildDryRunSummary(job: RunJob): DryRunSummary {
  const selectedItems = job.items.filter((item) => item.selected);
  return {
    totalFound: job.items.length,
    selected: selectedItems.length,
    copyable: selectedItems.filter((item) => item.copyCapability === 'available').length,
    blocked: selectedItems.filter((item) => item.copyCapability === 'unavailable').length,
    ambiguous: selectedItems.filter(
      (item) => item.copyCapability === 'unknown' || item.ownerConfidence === 'unknown' || item.ownerConfidence === 'low',
    ).length,
    byTeam: job.sourceTeams.map((team) => {
      const items = itemsForTeam(job, team.internalId);
      const selected = items.filter((item) => item.selected);
      return {
        teamId: team.internalId,
        displayName: team.displayName,
        found: items.length,
        selected: selected.length,
        copyable: selected.filter((item) => item.copyCapability === 'available').length,
      };
    }),
  };
}
