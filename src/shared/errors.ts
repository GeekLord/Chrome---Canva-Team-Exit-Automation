/**
 * Normalized error taxonomy.
 *
 * Every failure anywhere in the extension is funnelled through
 * `normalizeError` so the run log, the popup and the retry policy all reason
 * about the same finite set of categories. No silent failures: an unmapped
 * throw becomes `unknown`, which is still surfaced to the user.
 */

export const ERROR_CATEGORIES = [
  'selector_not_found',
  'dialog_not_opened',
  'destination_not_found',
  'copy_action_missing',
  'copy_verification_failed',
  'delete_action_missing',
  'delete_failed',
  'leave_blocked_by_policy',
  'auth_required',
  'unexpected_navigation',
  'rate_limited_or_captcha',
  'ownership_ambiguous',
  'unknown',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** What the run engine should do about a failure. */
export type ErrorResolution = 'retry' | 'skip' | 'pause' | 'block';

export interface NormalizedError {
  category: ErrorCategory;
  /** Short machine-ish summary, safe to show in a list. */
  message: string;
  /** Raw detail: thrown message, stack, selector description, DOM hints. */
  detail: string | null;
  /** Plain-language explanation for the operator. */
  explanation: string;
  /** Concrete next step the operator can take. */
  nextStep: string;
  /** First-choice resolution. The engine may escalate after retries. */
  resolution: ErrorResolution;
  /** Where the failure should land if retries are exhausted. */
  escalation: Exclude<ErrorResolution, 'retry'>;
  /** True when trying the exact same action again is worth doing. */
  retryable: boolean;
}

interface CategoryGuidance {
  message: string;
  explanation: string;
  nextStep: string;
  resolution: ErrorResolution;
  escalation: Exclude<ErrorResolution, 'retry'>;
}

/**
 * Operator-facing guidance per category. Wording follows the project rule:
 * "copy" and "trash", never "transfer" and "delete".
 */
export const ERROR_GUIDANCE: Record<ErrorCategory, CategoryGuidance> = {
  selector_not_found: {
    message: 'Expected Canva control was not found',
    explanation:
      'The extension looked for a control on the Canva page and none of its known variants matched. Canva most likely changed its interface.',
    nextStep:
      'Retry once. If it keeps failing, handle this item manually and report the selector version shown in Options so the selector map can be updated.',
    resolution: 'retry',
    escalation: 'skip',
  },
  dialog_not_opened: {
    message: 'Canva dialog did not open',
    explanation:
      'The action was triggered but the expected Canva dialog never appeared. This is usually a slow render or a click that landed on the wrong element.',
    nextStep: 'Retry. If the page looks stuck, refresh the Canva tab and resume the run.',
    resolution: 'retry',
    escalation: 'skip',
  },
  destination_not_found: {
    message: 'Copy destination is not available',
    explanation:
      'The destination workspace chosen for this run was not listed in the copy dialog. It may have been renamed, or your access to it changed.',
    nextStep: 'Pause, re-scan destinations in the popup, pick the destination again, then resume.',
    resolution: 'pause',
    escalation: 'pause',
  },
  copy_action_missing: {
    message: 'No copy action offered for this item',
    explanation:
      'Canva did not offer a copy-to-another-team action for this item. Some item types and some permission levels do not support it.',
    nextStep: 'Skip this item and copy it manually if you need it. The original is never trashed without a verified copy.',
    resolution: 'skip',
    escalation: 'skip',
  },
  copy_verification_failed: {
    message: 'Copy could not be verified',
    explanation:
      'The copy was attempted but the extension could not confirm the item exists in the destination. The original is therefore left untouched.',
    nextStep: 'Check the destination workspace yourself. Mark the item verified manually, or skip it.',
    resolution: 'skip',
    escalation: 'skip',
  },
  delete_action_missing: {
    message: 'No trash action offered for this item',
    explanation:
      'Canva did not offer a move-to-trash action for the original item, so the original stays in the source team.',
    nextStep: 'Trash the original manually, or leave it in place. This item will keep the team leave step blocked.',
    resolution: 'skip',
    escalation: 'skip',
  },
  delete_failed: {
    message: 'Move to trash failed',
    explanation:
      'The trash action was triggered but Canva did not confirm it. The original may still be in the source team.',
    nextStep: 'Retry. If it fails again, trash the original manually before leaving the team.',
    resolution: 'retry',
    escalation: 'skip',
  },
  leave_blocked_by_policy: {
    message: 'Leaving the team is blocked',
    explanation:
      'Canva did not allow the leave action. Team admins can restrict who is allowed to leave, and the last remaining owner usually cannot.',
    nextStep: 'Ask a team admin to remove you, or transfer ownership first. Your copies are already safe in the destination.',
    resolution: 'block',
    escalation: 'block',
  },
  auth_required: {
    message: 'Canva needs you to sign in again',
    explanation: 'The Canva tab is showing a sign-in or re-authentication screen, so no automation can continue.',
    nextStep: 'Sign in to Canva in that tab, then resume the run. Progress up to this point is saved.',
    resolution: 'block',
    escalation: 'block',
  },
  unexpected_navigation: {
    message: 'Canva navigated somewhere unexpected',
    explanation:
      'The page changed to something the extension did not expect mid-action, so the action was abandoned rather than clicking blindly.',
    nextStep: 'Retry. The extension will navigate back to the expected view first.',
    resolution: 'retry',
    escalation: 'skip',
  },
  rate_limited_or_captcha: {
    message: 'Canva is showing a verification or rate-limit screen',
    explanation:
      'A CAPTCHA or abuse-prevention screen was detected. Continuing would mean clicking through a protection screen, which this extension will not do.',
    nextStep:
      'Clear the check manually in the Canva tab, wait a few minutes, increase the action delay in Options, then resume.',
    resolution: 'block',
    escalation: 'block',
  },
  ownership_ambiguous: {
    message: 'Item ownership could not be determined',
    explanation:
      'The listing did not clearly show that you own this item. The extension will not copy or trash content it cannot attribute to you.',
    nextStep: 'Open the item in Canva to check ownership, then include it manually or leave it excluded.',
    resolution: 'skip',
    escalation: 'skip',
  },
  unknown: {
    message: 'Unexpected failure',
    explanation: 'Something failed in a way the extension does not have a specific category for. Raw detail is in the run log.',
    nextStep: 'Retry once, then skip the item and export the log if you want to investigate.',
    resolution: 'retry',
    escalation: 'skip',
  },
};

export function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === 'string' && (ERROR_CATEGORIES as readonly string[]).includes(value);
}

/** Errors that mean "stop the whole run", not "skip this item". */
export function isHaltingCategory(category: ErrorCategory): boolean {
  return (
    category === 'auth_required' ||
    category === 'rate_limited_or_captcha' ||
    category === 'leave_blocked_by_policy'
  );
}

export interface NormalizeErrorInput {
  category: ErrorCategory;
  detail?: string | null;
  /** Overrides the canned short message when a more specific one helps. */
  message?: string;
  /** Overrides the canned first-choice resolution. */
  resolution?: ErrorResolution;
}

export function normalizeError(input: NormalizeErrorInput): NormalizedError {
  const guidance = ERROR_GUIDANCE[input.category];
  const resolution = input.resolution ?? guidance.resolution;
  return {
    category: input.category,
    message: input.message ?? guidance.message,
    detail: input.detail ?? null,
    explanation: guidance.explanation,
    nextStep: guidance.nextStep,
    resolution,
    escalation: guidance.escalation,
    retryable: resolution === 'retry',
  };
}

/**
 * Turns an unknown thrown value into readable raw detail.
 *
 * Always returns a string: this runs inside the failure path, so it must not be
 * capable of throwing or of producing `undefined`.
 */
export function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.stack ? `${thrown.name}: ${thrown.message}\n${thrown.stack}` : `${thrown.name}: ${thrown.message}`;
  }
  if (typeof thrown === 'string') return thrown;
  if (thrown === undefined) return 'undefined';
  try {
    // JSON.stringify yields undefined for functions and symbols.
    return JSON.stringify(thrown) ?? String(thrown);
  } catch {
    return String(thrown);
  }
}

/**
 * Maps an arbitrary thrown value onto the taxonomy. Content-script code throws
 * `ActionError` with an explicit category; anything else falls back to
 * `fallbackCategory`, and text sniffing only ever *upgrades* to a
 * halting category so an auth screen is never mistaken for a missing selector.
 */
export function categorizeThrown(thrown: unknown, fallbackCategory: ErrorCategory = 'unknown'): ErrorCategory {
  if (thrown instanceof ActionError) return thrown.category;

  const text = describeThrown(thrown).toLowerCase();
  if (text.includes('captcha') || text.includes('are you a robot') || text.includes('rate limit')) {
    return 'rate_limited_or_captcha';
  }
  if (text.includes('log in') || text.includes('sign in') || text.includes('session expired') || text.includes('401')) {
    return 'auth_required';
  }
  if (text.includes('timeout') || text.includes('timed out')) {
    return fallbackCategory === 'unknown' ? 'selector_not_found' : fallbackCategory;
  }
  return fallbackCategory;
}

/** Error type used by content-script action executors. */
export class ActionError extends Error {
  readonly category: ErrorCategory;
  readonly detail: string | null;

  constructor(category: ErrorCategory, message: string, detail?: string | null) {
    super(message);
    this.name = 'ActionError';
    this.category = category;
    this.detail = detail ?? null;
  }
}

export function toNormalizedError(thrown: unknown, fallbackCategory: ErrorCategory = 'unknown'): NormalizedError {
  const category = categorizeThrown(thrown, fallbackCategory);
  const message = thrown instanceof ActionError ? thrown.message : undefined;
  const detail = thrown instanceof ActionError ? (thrown.detail ?? thrown.message) : describeThrown(thrown);
  return normalizeError({ category, message, detail });
}
