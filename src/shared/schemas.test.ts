import { describe, expect, it } from 'vitest';

import { makeItem, makeReadyJob, makeSettings } from '../testing/fixtures';
import { MIN_ACTION_DELAY_MS } from './constants';
import {
  designItemSchema,
  logEventSchema,
  parseOrDefault,
  runJobSchema,
  settingsSchema,
} from './schemas';
import { clampSettings, DEFAULT_SETTINGS, liveExecutionAllowed } from './settings';
import { parseContentRequest, parseUiCommand } from './messages';

describe('entity schemas', () => {
  it('round-trips a run job through JSON', () => {
    const job = makeReadyJob({ mode: 'copyVerifyTrashLeave' });
    const parsed = runJobSchema.safeParse(JSON.parse(JSON.stringify(job)));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.runId).toBe(job.runId);
  });

  it('rejects an item with an unknown state', () => {
    const bad = { ...makeItem(), state: 'teleported' };
    expect(designItemSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a log event with an unknown error category', () => {
    const event = {
      eventId: 'evt_1',
      runId: 'run_1',
      timestamp: '2026-08-04T10:00:00.000Z',
      level: 'info',
      entityType: 'item',
      entityId: 'item_1',
      action: 'copyItem',
      message: 'x',
      detail: null,
      sourceTeamId: null,
      sourceTeamName: null,
      itemTitle: null,
      resultStatus: 'success',
      verificationLevel: null,
      errorCategory: 'made_up_category',
      screenshotRef: null,
    };
    expect(logEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('parseOrDefault', () => {
  it('returns the default for missing data without reporting a problem', () => {
    const result = parseOrDefault(settingsSchema, undefined, DEFAULT_SETTINGS);
    expect(result.ok).toBe(true);
    expect(result.issue).toBeNull();
    expect(result.value).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back and explains itself when stored data is corrupt', () => {
    const result = parseOrDefault(settingsSchema, { version: 'one' }, DEFAULT_SETTINGS);
    expect(result.ok).toBe(false);
    expect(result.value).toEqual(DEFAULT_SETTINGS);
    expect(result.issue).toContain('version');
  });
});

describe('settings safety', () => {
  it('starts a fresh profile in dry-run mode with live execution off', () => {
    expect(DEFAULT_SETTINGS.defaultMode).toBe('dryRun');
    expect(DEFAULT_SETTINGS.liveExecutionEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.disclosureAcceptedAt).toBeNull();
    expect(DEFAULT_SETTINGS.overrides.allowTrashWithoutVerification).toBe(false);
    expect(DEFAULT_SETTINGS.overrides.allowLeaveWithUnresolvedItems).toBe(false);
  });

  it('needs both the disclosure and the toggle before live execution is allowed', () => {
    expect(liveExecutionAllowed(makeSettings({ liveExecutionEnabled: true }))).toBe(false);
    expect(liveExecutionAllowed(makeSettings({ disclosureAcceptedAt: '2026-08-04T00:00:00.000Z' }))).toBe(false);
    expect(
      liveExecutionAllowed(
        makeSettings({ liveExecutionEnabled: true, disclosureAcceptedAt: '2026-08-04T00:00:00.000Z' }),
      ),
    ).toBe(true);
  });

  it('clamps a hand-edited delay back above the pacing floor', () => {
    const clamped = clampSettings(makeSettings({ actionDelayMs: 0, actionJitterMs: -5 }));
    expect(clamped.actionDelayMs).toBe(MIN_ACTION_DELAY_MS);
    expect(clamped.actionJitterMs).toBe(0);
  });

  it('clamps nonsense numbers to usable ranges', () => {
    const clamped = clampSettings(
      makeSettings({
        maxRetriesPerAction: 99,
        backoffMultiplier: 0.1,
        circuitBreakerThreshold: 0,
        probeItemLimitPerTeam: 9999,
        actionTimeoutMs: Number.NaN,
      }),
    );
    expect(clamped.maxRetriesPerAction).toBe(10);
    expect(clamped.backoffMultiplier).toBe(1);
    expect(clamped.circuitBreakerThreshold).toBe(1);
    expect(clamped.probeItemLimitPerTeam).toBe(500);
    expect(clamped.actionTimeoutMs).toBe(DEFAULT_SETTINGS.actionTimeoutMs);
  });
});

describe('message boundaries', () => {
  it('accepts a well-formed command', () => {
    expect(parseUiCommand({ type: 'START_RUN' })).toEqual({ type: 'START_RUN' });
  });

  it('rejects an unknown or malformed command', () => {
    expect(parseUiCommand({ type: 'DELETE_EVERYTHING' })).toBeNull();
    expect(parseUiCommand({ type: 'SET_ITEM_INCLUSION', itemId: 5, selected: 'yes' })).toBeNull();
    expect(parseUiCommand('START_RUN')).toBeNull();
  });

  it('rejects a content request with a bad action payload', () => {
    expect(parseContentRequest({ type: 'PING' })).toEqual({ type: 'PING' });
    expect(parseContentRequest({ type: 'TRASH_ITEM', item: { title: 'x' } })).toBeNull();
  });

  it('accepts a content request carrying a real item', () => {
    const request = parseContentRequest({
      type: 'TRASH_ITEM',
      item: JSON.parse(JSON.stringify(makeItem())),
      options: { timeoutMs: 1000, stepDelayMs: 10, stepJitterMs: 0, debug: false, dryRun: false },
    });
    expect(request?.type).toBe('TRASH_ITEM');
  });
});
