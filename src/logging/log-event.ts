import { newEventId } from '../shared/ids';
import type { LogEvent, LogEventDraft } from '../shared/types';

/** Stamps a draft with identity and time. Drafts come from the reducer and executors. */
export function materializeLogEvent(runId: string, draft: LogEventDraft, now: string): LogEvent {
  return {
    eventId: newEventId(),
    runId,
    timestamp: now,
    ...draft,
  };
}

export function materializeLogEvents(runId: string, drafts: readonly LogEventDraft[], now: string): LogEvent[] {
  return drafts.map((draft) => materializeLogEvent(runId, draft, now));
}

/** Compact single-line rendering used by debug-mode console output. */
export function formatLogLine(event: LogEvent): string {
  const parts = [
    event.timestamp,
    event.level.toUpperCase(),
    event.action,
    event.resultStatus,
    event.itemTitle ? `"${event.itemTitle}"` : null,
    event.sourceTeamName ? `[${event.sourceTeamName}]` : null,
    event.message,
    event.errorCategory ? `(${event.errorCategory})` : null,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);
  return parts.join(' | ');
}
