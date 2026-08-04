import { describe, expect, it } from 'vitest';

import { makeReadyJob, NOW } from '../testing/fixtures';
import type { LogEvent } from '../shared/types';
import { buildExportBundle, escapeCsvCell, exportFileName, LOG_CSV_COLUMNS, toCsv, toJson } from './exporters';

function event(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    eventId: 'evt_1',
    runId: 'run_test',
    timestamp: NOW,
    level: 'info',
    entityType: 'item',
    entityId: 'item_1',
    action: 'copyItem',
    message: 'Copied "Quarterly report"',
    detail: null,
    sourceTeamId: 'team_source',
    sourceTeamName: 'Design Studio',
    itemTitle: 'Quarterly report',
    resultStatus: 'success',
    verificationLevel: 'strong',
    errorCategory: null,
    screenshotRef: null,
    ...overrides,
  };
}

describe('CSV export', () => {
  it('writes a header row and one row per event', () => {
    const csv = toCsv([event(), event({ eventId: 'evt_2' })]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(LOG_CSV_COLUMNS.join(','));
  });

  it('quotes and escapes cells containing commas, quotes or newlines', () => {
    expect(escapeCsvCell('plain')).toBe('plain');
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formulas in user-controlled text', () => {
    expect(escapeCsvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('-cmd')).toBe("'-cmd");
    expect(escapeCsvCell('@import')).toBe("'@import");
  });

  it('renders empty cells for null and undefined', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('keeps a design title with a comma on one row', () => {
    const csv = toCsv([event({ itemTitle: 'Report, final', message: 'Copied "Report, final"' })]);
    expect(csv.split('\r\n')).toHaveLength(2);
    expect(csv).toContain('"Report, final"');
  });
});

describe('JSON export', () => {
  it('bundles the report, the run and the events together', () => {
    const job = makeReadyJob({ mode: 'copyVerifyTrash' });
    const bundle = buildExportBundle(job, [event()], NOW);

    expect(bundle.formatVersion).toBe(1);
    expect(bundle.exportedAt).toBe(NOW);
    expect(bundle.selectorMapVersion).toBe('test-selector-map');
    expect(bundle.report.runId).toBe(job.runId);
    expect(bundle.run.runId).toBe(job.runId);
    expect(bundle.events).toHaveLength(1);

    const parsed = JSON.parse(toJson(bundle)) as typeof bundle;
    expect(parsed.report.itemsSelected).toBe(job.counters.itemsSelected);
  });
});

describe('export file names', () => {
  it('builds a filesystem-safe name from the run id and timestamp', () => {
    const name = exportFileName('run_abc-123', 'csv', NOW);
    expect(name).toBe('canva-team-exit-run_abc-123-2026-08-04T10-00-00-000Z.csv');
    expect(name).not.toMatch(/[:*?"<>|]/);
  });

  it('strips characters that are not safe in a file name', () => {
    expect(exportFileName('run/../etc', 'json', NOW)).toContain('run-etc');
  });
});
