import { describe, expect, it } from 'vitest';

import {
  ActionError,
  categorizeThrown,
  describeThrown,
  ERROR_CATEGORIES,
  ERROR_GUIDANCE,
  isHaltingCategory,
  normalizeError,
  toNormalizedError,
} from './errors';

describe('error taxonomy', () => {
  it('gives every category a plain-language explanation and a next step', () => {
    for (const category of ERROR_CATEGORIES) {
      const guidance = ERROR_GUIDANCE[category];
      expect(guidance.explanation.length, category).toBeGreaterThan(20);
      expect(guidance.nextStep.length, category).toBeGreaterThan(10);
      expect(['retry', 'skip', 'pause', 'block']).toContain(guidance.resolution);
    }
  });

  it('treats auth, captcha and leave policy as run-halting', () => {
    expect(isHaltingCategory('auth_required')).toBe(true);
    expect(isHaltingCategory('rate_limited_or_captcha')).toBe(true);
    expect(isHaltingCategory('leave_blocked_by_policy')).toBe(true);
    expect(isHaltingCategory('selector_not_found')).toBe(false);
  });

  it('never marks a non-retry resolution as retryable', () => {
    expect(normalizeError({ category: 'copy_action_missing' }).retryable).toBe(false);
    expect(normalizeError({ category: 'selector_not_found' }).retryable).toBe(true);
  });

  it('keeps raw detail alongside the friendly wording', () => {
    const normalized = normalizeError({ category: 'delete_failed', detail: 'button#confirm missing' });
    expect(normalized.detail).toBe('button#confirm missing');
    expect(normalized.message).not.toContain('button#confirm');
  });
});

describe('categorizeThrown', () => {
  it('trusts the category an ActionError carries', () => {
    expect(categorizeThrown(new ActionError('destination_not_found', 'nope'))).toBe('destination_not_found');
  });

  it('upgrades captcha and auth wording regardless of the fallback', () => {
    expect(categorizeThrown(new Error('Please verify you are human (captcha)'), 'selector_not_found')).toBe(
      'rate_limited_or_captcha',
    );
    expect(categorizeThrown(new Error('Your session has expired, please sign in'), 'selector_not_found')).toBe(
      'auth_required',
    );
  });

  it('maps a bare timeout onto a selector problem', () => {
    expect(categorizeThrown(new Error('Timed out waiting for the dialog'))).toBe('selector_not_found');
  });

  it('prefers the caller fallback for a timeout when one is given', () => {
    expect(categorizeThrown(new Error('timed out'), 'delete_failed')).toBe('delete_failed');
  });

  it('falls back to unknown for anything unrecognisable', () => {
    expect(categorizeThrown({ weird: true })).toBe('unknown');
    expect(categorizeThrown(undefined)).toBe('unknown');
  });
});

describe('toNormalizedError', () => {
  it('carries the ActionError message and detail through', () => {
    const normalized = toNormalizedError(
      new ActionError('copy_action_missing', 'No copy entry', 'menu had 3 entries'),
    );
    expect(normalized.category).toBe('copy_action_missing');
    expect(normalized.message).toBe('No copy entry');
    expect(normalized.detail).toBe('menu had 3 entries');
  });

  it('records a stack for an ordinary throw', () => {
    const normalized = toNormalizedError(new Error('boom'), 'delete_failed');
    expect(normalized.category).toBe('delete_failed');
    expect(normalized.detail).toContain('boom');
  });

  it('describes non-error values without throwing', () => {
    expect(describeThrown('plain string')).toBe('plain string');
    expect(describeThrown({ a: 1 })).toBe('{"a":1}');
    expect(describeThrown(null)).toBe('null');
  });
});
