/**
 * Reading Canva's transient notifications.
 *
 * An explicit success notification is the strongest verification signal the
 * extension can get without leaving the page, so it is treated as first-class
 * evidence in the copy playbook.
 */

import { rawText, resolveAll } from './dom-utils';
import { SELECTORS } from './selector-map';

export const COPY_SUCCESS_PATTERN = /(copied|copy complete|added to|saved to|now in)/i;
export const TRASH_SUCCESS_PATTERN = /(trash|bin|deleted|removed)/i;
export const LEAVE_SUCCESS_PATTERN = /(left|no longer a member|removed from)/i;
export const FAILURE_PATTERN = /(couldn'?t|could not|can'?t|failed|error|went wrong|unable|not allowed)/i;

export function readToasts(): string[] {
  return resolveAll(SELECTORS.successToast)
    .map((match) => rawText(match.element))
    .filter((text) => text.length > 0 && text.length < 400);
}

export function findToast(pattern: RegExp): string | null {
  return readToasts().find((text) => pattern.test(text)) ?? null;
}
