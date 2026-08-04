/**
 * Log exporters. Exports only ever run on an explicit user action, and the
 * output stays on the user's machine: the popup turns these strings into a Blob
 * and an anchor click, so no `downloads` permission and no network call.
 */

import { EXTENSION_NAME } from '../shared/constants';
import { buildRunReport, type RunReport } from '../shared/report';
import type { LogEvent, RunJob } from '../shared/types';

export const LOG_CSV_COLUMNS = [
  'eventId',
  'runId',
  'timestamp',
  'level',
  'entityType',
  'entityId',
  'action',
  'sourceTeamId',
  'sourceTeamName',
  'itemTitle',
  'resultStatus',
  'verificationLevel',
  'errorCategory',
  'message',
  'detail',
  'screenshotRef',
] as const satisfies readonly (keyof LogEvent)[];

/**
 * Spreadsheet applications treat a leading `=`, `+`, `-` or `@` as a formula.
 * Design titles are user-controlled text, so neutralise those.
 */
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = neutralizeFormula(String(value));
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function toCsv(events: readonly LogEvent[]): string {
  const header = LOG_CSV_COLUMNS.join(',');
  const rows = events.map((event) => LOG_CSV_COLUMNS.map((column) => escapeCsvCell(event[column])).join(','));
  return [header, ...rows].join('\r\n');
}

export interface ExportBundle {
  exportedBy: string;
  exportedAt: string;
  formatVersion: 1;
  selectorMapVersion: string;
  report: RunReport;
  run: RunJob;
  events: LogEvent[];
}

export function buildExportBundle(job: RunJob, events: readonly LogEvent[], now: string): ExportBundle {
  return {
    exportedBy: EXTENSION_NAME,
    exportedAt: now,
    formatVersion: 1,
    selectorMapVersion: job.settings.selectorMapVersion,
    report: buildRunReport(job),
    run: job,
    events: [...events],
  };
}

export function toJson(bundle: ExportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Reduces a segment to characters that are safe in a file name. Dots are dropped
 * too, so a run id can never contribute a `..` sequence or a second extension.
 */
function safeSegment(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'run'
  );
}

export function exportFileName(runId: string, extension: 'json' | 'csv', now: string): string {
  const stamp = now.replace(/[:.]/g, '-');
  return `canva-team-exit-${safeSegment(runId)}-${safeSegment(stamp)}.${extension}`;
}
