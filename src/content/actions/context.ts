/**
 * Shared plumbing for action executors.
 *
 * Executors are discrete playbooks invoked by the background engine. They never
 * decide *whether* to run: the engine and the guards do that. What they own is
 * pacing, timeouts, and honest failure categories.
 */

import { ActionError, type ErrorCategory } from '../../shared/errors';
import type { ActionOptions } from '../../shared/messages';
import { Deadline, jitteredDelay, sleep, type WaitOptions } from '../dom-utils';

export interface ActionContext {
  options: ActionOptions;
  deadline: Deadline;
  /** Verbose breadcrumbs, forwarded to the run log when debug mode is on. */
  debug(message: string, detail?: string): void;
  /** Paced pause between individual interactions, with jitter. */
  step(multiplier?: number): Promise<void>;
  /** Wait options bounded by the action deadline. */
  wait(description: string, category?: ErrorCategory, timeoutMs?: number): WaitOptions;
}

export function createActionContext(
  options: ActionOptions,
  onDebug: (message: string, detail?: string) => void,
): ActionContext {
  const deadline = new Deadline(options.timeoutMs);
  return {
    options,
    deadline,
    debug(message, detail) {
      if (options.debug) onDebug(message, detail);
    },
    async step(multiplier = 1) {
      await sleep(jitteredDelay(options.stepDelayMs * multiplier, options.stepJitterMs));
    },
    wait(description, category, timeoutMs) {
      return {
        deadline: timeoutMs === undefined ? deadline : deadline.slice(timeoutMs),
        description,
        ...(category ? { category } : {}),
      };
    },
  };
}

/**
 * Hard stop for dry runs. The engine already refuses to plan mutating actions in
 * dry-run mode; this is the second lock on the same door.
 */
export function assertMutationAllowed(ctx: ActionContext, action: string): void {
  if (ctx.options.dryRun) {
    throw new ActionError(
      'unknown',
      `Refused to run "${action}" because this run is a dry run`,
      'dryRun=true was passed to a mutating action; this is a bug in the caller',
    );
  }
}
