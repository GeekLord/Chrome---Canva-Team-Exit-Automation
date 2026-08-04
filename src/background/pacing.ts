/**
 * Pacing and backoff.
 *
 * The extension deliberately works at human speed. Delays carry jitter so the
 * traffic pattern is not metronomic, and repeated failures widen the gap before
 * the next attempt.
 */

import { MIN_ACTION_DELAY_MS } from '../shared/constants';
import type { Settings } from '../shared/types';

export function jitter(baseMs: number, jitterMs: number): number {
  if (jitterMs <= 0) return Math.max(0, baseMs);
  return Math.max(0, Math.round(baseMs + Math.random() * jitterMs));
}

/** Delay before the next planned action. */
export function actionDelay(settings: Settings): number {
  return jitter(Math.max(MIN_ACTION_DELAY_MS, settings.actionDelayMs), settings.actionJitterMs);
}

/** Delay before retry number `attempt` (1-based) of the same action. */
export function retryDelay(settings: Settings, attempt: number): number {
  const growth = Math.pow(settings.backoffMultiplier, Math.max(0, attempt - 1));
  const base = Math.max(MIN_ACTION_DELAY_MS, settings.actionDelayMs) * growth;
  return jitter(Math.min(base, 60_000), settings.actionJitterMs);
}

/**
 * Extra cooling-off applied after a streak of failures across items, so a broken
 * selector does not turn into a burst of pointless clicking.
 */
export function streakDelay(settings: Settings, consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return 0;
  return Math.min(30_000, actionDelay(settings) * consecutiveFailures);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Keeps the MV3 service worker from being evicted mid-run.
 *
 * A storage touch resets the idle timer. This only runs while a run is active,
 * and needs no extra permission.
 */
export class KeepAlive {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly intervalMs = 20_000) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void chrome.storage.local.get('ctea.keepalive');
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
