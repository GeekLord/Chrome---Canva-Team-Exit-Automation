import { C as withRecomputedCounters, S as mapItem, a as canStartRun, b as isVerified, d as modeAllowsTrash, f as modeAllowsVerify, i as canLeaveTeam, l as modeAllowsCopy, o as canTrashItem, p as nextItemNeedingWork, r as blockingItems, s as itemNeedsWork, u as modeAllowsLeave, v as findItem, x as itemsForTeam, y as findTeam } from "./report.js";
//#region src/shared/errors.ts
/**
* Normalized error taxonomy.
*
* Every failure anywhere in the extension is funnelled through
* `normalizeError` so the run log, the popup and the retry policy all reason
* about the same finite set of categories. No silent failures: an unmapped
* throw becomes `unknown`, which is still surfaced to the user.
*/
var ERROR_CATEGORIES = [
	"selector_not_found",
	"dialog_not_opened",
	"destination_not_found",
	"copy_action_missing",
	"copy_verification_failed",
	"delete_action_missing",
	"delete_failed",
	"leave_blocked_by_policy",
	"auth_required",
	"unexpected_navigation",
	"rate_limited_or_captcha",
	"ownership_ambiguous",
	"unknown"
];
/**
* Operator-facing guidance per category. Wording follows the project rule:
* "copy" and "trash", never "transfer" and "delete".
*/
var ERROR_GUIDANCE = {
	selector_not_found: {
		message: "Expected Canva control was not found",
		explanation: "The extension looked for a control on the Canva page and none of its known variants matched. Canva most likely changed its interface.",
		nextStep: "Retry once. If it keeps failing, handle this item manually and report the selector version shown in Options so the selector map can be updated.",
		resolution: "retry",
		escalation: "skip"
	},
	dialog_not_opened: {
		message: "Canva dialog did not open",
		explanation: "The action was triggered but the expected Canva dialog never appeared. This is usually a slow render or a click that landed on the wrong element.",
		nextStep: "Retry. If the page looks stuck, refresh the Canva tab and resume the run.",
		resolution: "retry",
		escalation: "skip"
	},
	destination_not_found: {
		message: "Copy destination is not available",
		explanation: "The destination workspace chosen for this run was not listed in the copy dialog. It may have been renamed, or your access to it changed.",
		nextStep: "Pause, re-scan destinations in the popup, pick the destination again, then resume.",
		resolution: "pause",
		escalation: "pause"
	},
	copy_action_missing: {
		message: "No copy action offered for this item",
		explanation: "Canva did not offer a copy-to-another-team action for this item. Some item types and some permission levels do not support it.",
		nextStep: "Skip this item and copy it manually if you need it. The original is never trashed without a verified copy.",
		resolution: "skip",
		escalation: "skip"
	},
	copy_verification_failed: {
		message: "Copy could not be verified",
		explanation: "The copy was attempted but the extension could not confirm the item exists in the destination. The original is therefore left untouched.",
		nextStep: "Check the destination workspace yourself. Mark the item verified manually, or skip it.",
		resolution: "skip",
		escalation: "skip"
	},
	delete_action_missing: {
		message: "No trash action offered for this item",
		explanation: "Canva did not offer a move-to-trash action for the original item, so the original stays in the source team.",
		nextStep: "Trash the original manually, or leave it in place. This item will keep the team leave step blocked.",
		resolution: "skip",
		escalation: "skip"
	},
	delete_failed: {
		message: "Move to trash failed",
		explanation: "The trash action was triggered but Canva did not confirm it. The original may still be in the source team.",
		nextStep: "Retry. If it fails again, trash the original manually before leaving the team.",
		resolution: "retry",
		escalation: "skip"
	},
	leave_blocked_by_policy: {
		message: "Leaving the team is blocked",
		explanation: "Canva did not allow the leave action. Team admins can restrict who is allowed to leave, and the last remaining owner usually cannot.",
		nextStep: "Ask a team admin to remove you, or transfer ownership first. Your copies are already safe in the destination.",
		resolution: "block",
		escalation: "block"
	},
	auth_required: {
		message: "Canva needs you to sign in again",
		explanation: "The Canva tab is showing a sign-in or re-authentication screen, so no automation can continue.",
		nextStep: "Sign in to Canva in that tab, then resume the run. Progress up to this point is saved.",
		resolution: "block",
		escalation: "block"
	},
	unexpected_navigation: {
		message: "Canva navigated somewhere unexpected",
		explanation: "The page changed to something the extension did not expect mid-action, so the action was abandoned rather than clicking blindly.",
		nextStep: "Retry. The extension will navigate back to the expected view first.",
		resolution: "retry",
		escalation: "skip"
	},
	rate_limited_or_captcha: {
		message: "Canva is showing a verification or rate-limit screen",
		explanation: "A CAPTCHA or abuse-prevention screen was detected. Continuing would mean clicking through a protection screen, which this extension will not do.",
		nextStep: "Clear the check manually in the Canva tab, wait a few minutes, increase the action delay in Options, then resume.",
		resolution: "block",
		escalation: "block"
	},
	ownership_ambiguous: {
		message: "Item ownership could not be determined",
		explanation: "The listing did not clearly show that you own this item. The extension will not copy or trash content it cannot attribute to you.",
		nextStep: "Open the item in Canva to check ownership, then include it manually or leave it excluded.",
		resolution: "skip",
		escalation: "skip"
	},
	unknown: {
		message: "Unexpected failure",
		explanation: "Something failed in a way the extension does not have a specific category for. Raw detail is in the run log.",
		nextStep: "Retry once, then skip the item and export the log if you want to investigate.",
		resolution: "retry",
		escalation: "skip"
	}
};
/** Errors that mean "stop the whole run", not "skip this item". */
function isHaltingCategory(category) {
	return category === "auth_required" || category === "rate_limited_or_captcha" || category === "leave_blocked_by_policy";
}
function normalizeError(input) {
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
		retryable: resolution === "retry"
	};
}
/**
* Turns an unknown thrown value into readable raw detail.
*
* Always returns a string: this runs inside the failure path, so it must not be
* capable of throwing or of producing `undefined`.
*/
function describeThrown(thrown) {
	if (thrown instanceof Error) return thrown.stack ? `${thrown.name}: ${thrown.message}\n${thrown.stack}` : `${thrown.name}: ${thrown.message}`;
	if (typeof thrown === "string") return thrown;
	if (thrown === void 0) return "undefined";
	try {
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
function categorizeThrown(thrown, fallbackCategory = "unknown") {
	if (thrown instanceof ActionError) return thrown.category;
	const text = describeThrown(thrown).toLowerCase();
	if (text.includes("captcha") || text.includes("are you a robot") || text.includes("rate limit")) return "rate_limited_or_captcha";
	if (text.includes("log in") || text.includes("sign in") || text.includes("session expired") || text.includes("401")) return "auth_required";
	if (text.includes("timeout") || text.includes("timed out")) return fallbackCategory === "unknown" ? "selector_not_found" : fallbackCategory;
	return fallbackCategory;
}
/** Error type used by content-script action executors. */
var ActionError = class extends Error {
	category;
	detail;
	constructor(category, message, detail) {
		super(message);
		this.name = "ActionError";
		this.category = category;
		this.detail = detail ?? null;
	}
};
function toNormalizedError(thrown, fallbackCategory = "unknown") {
	return normalizeError({
		category: categorizeThrown(thrown, fallbackCategory),
		message: thrown instanceof ActionError ? thrown.message : void 0,
		detail: thrown instanceof ActionError ? thrown.detail ?? thrown.message : describeThrown(thrown)
	});
}
//#endregion
//#region src/shared/run-state-machine.ts
var EXECUTING_STATES = [
	"copying",
	"verifying",
	"trashing",
	"leavingTeam"
];
var PRE_RUN_STATES = [
	"idle",
	"discoveringTeams",
	"selectingTeams",
	"discoveringItems",
	"reviewReady",
	"awaitingStartConfirmation"
];
var TERMINAL_STATES = [
	"completed",
	"completedWithWarnings",
	"failed"
];
function isExecuting(state) {
	return EXECUTING_STATES.includes(state);
}
function isPreRun(state) {
	return PRE_RUN_STATES.includes(state);
}
function isTerminal(state) {
	return TERMINAL_STATES.includes(state);
}
/** Builds a log draft, filling team/item context from the job. */
function buildLogDraft(job, input) {
	const item = input.itemId ? findItem(job, input.itemId) : void 0;
	const teamId = input.teamId ?? item?.sourceTeamId ?? job.activeTeamId ?? null;
	const team = teamId ? findTeam(job, teamId) : void 0;
	const entityType = input.itemId ? "item" : teamId ? "team" : "run";
	return {
		level: input.level ?? (input.resultStatus === "failure" || input.resultStatus === "blocked" ? "error" : input.resultStatus === "skipped" ? "warn" : "info"),
		entityType,
		entityId: input.itemId ?? teamId ?? null,
		action: input.action,
		message: input.message,
		detail: input.detail ?? input.error?.detail ?? null,
		sourceTeamId: teamId,
		sourceTeamName: team?.displayName ?? null,
		itemTitle: item?.title ?? null,
		resultStatus: input.resultStatus,
		verificationLevel: input.verificationLevel ?? item?.verificationStatus ?? null,
		errorCategory: input.error?.category ?? null,
		screenshotRef: input.screenshotRef ?? null
	};
}
function settle(job, ctx, logs) {
	return {
		job: withRecomputedCounters(job, ctx.now),
		logs
	};
}
/** Invalid transition: keep the job as-is, but never fail silently. */
function rejected(job, event, reason, detail) {
	return {
		job,
		logs: [buildLogDraft(job, {
			action: `reject:${event.type}`,
			message: `Ignored ${event.type}: ${reason}`,
			resultStatus: "info",
			level: "warn",
			detail: detail ?? null,
			itemId: "itemId" in event ? event.itemId : null,
			teamId: "teamId" in event ? event.teamId : null
		})]
	};
}
function appendNote(item, note) {
	return [...item.notes, note];
}
function withoutFlag(item, flag) {
	return item.riskFlags.filter((candidate) => candidate !== flag);
}
function withFlag(flags, flag) {
	return flags.includes(flag) ? flags : [...flags, flag];
}
/**
* Where a paused run should go when resumed. Derived rather than stored so a
* run recovered from storage lands somewhere consistent with its item states.
*/
function resolveResumeState(job) {
	if (job.activeTeamId) {
		if (nextItemNeedingWork(job, job.activeTeamId)) return "copying";
		if (modeAllowsLeave(job.mode) && !job.leftTeamIds.includes(job.activeTeamId)) return "awaitingLeaveConfirmation";
		return "copying";
	}
	if (job.teamQueue.length > 0) return "copying";
	if (isPreRun(job.state)) return job.state;
	return blockingItems(job).length > 0 ? "completedWithWarnings" : "completed";
}
function finishState(job) {
	return blockingItems(job).length > 0 ? "completedWithWarnings" : "completed";
}
function reduceRun(job, event, ctx) {
	switch (event.type) {
		case "TEAM_DISCOVERY_STARTED":
			if (isExecuting(job.state)) return rejected(job, event, "a run is already executing");
			return settle({
				...job,
				state: "discoveringTeams",
				currentAction: "Scanning teams you can switch into",
				blocker: null
			}, ctx, [buildLogDraft(job, {
				action: "discoverTeams",
				message: "Team discovery started",
				resultStatus: "started"
			})]);
		case "TEAMS_DISCOVERED": return settle({
			...job,
			state: "selectingTeams",
			currentAction: null
		}, ctx, [buildLogDraft(job, {
			action: "discoverTeams",
			message: `Found ${event.count} workspace(s) in this session`,
			resultStatus: "success"
		})]);
		case "TEAM_DISCOVERY_FAILED": return settle({
			...job,
			state: "failed",
			blocker: event.error,
			endedAt: ctx.now,
			currentAction: null
		}, ctx, [buildLogDraft(job, {
			action: "discoverTeams",
			message: `Team discovery failed: ${event.error.message}`,
			resultStatus: "failure",
			error: event.error
		})]);
		case "TEAMS_SELECTED": {
			if (!isPreRun(job.state)) return rejected(job, event, "teams cannot be changed once the run has started");
			const selectedIds = event.teams.map((team) => team.internalId);
			return settle({
				...job,
				sourceTeams: event.teams,
				teamQueue: selectedIds,
				processedTeamIds: [],
				items: job.items.filter((item) => selectedIds.includes(item.sourceTeamId)),
				state: "selectingTeams"
			}, ctx, [buildLogDraft(job, {
				action: "selectTeams",
				message: `Selected ${event.teams.length} source team(s)`,
				resultStatus: "info",
				detail: event.teams.map((team) => team.displayName).join(", ") || null
			})]);
		}
		case "DESTINATION_SELECTED":
			if (!isPreRun(job.state)) return rejected(job, event, "destination is locked once the run has started");
			return settle({
				...job,
				destination: event.destination
			}, ctx, [buildLogDraft(job, {
				action: "selectDestination",
				message: event.destination ? `Destination set to "${event.destination.displayName}"` : "Destination cleared",
				resultStatus: "info"
			})]);
		case "MODE_SELECTED":
			if (!isPreRun(job.state)) return rejected(job, event, "mode is locked once the run has started");
			return settle({
				...job,
				mode: event.mode,
				confirmations: {
					scopes: [],
					leaveConfirmedTeamIds: []
				}
			}, ctx, [buildLogDraft(job, {
				action: "selectMode",
				message: `Execution mode set to "${event.mode}". Confirmations reset.`,
				resultStatus: "info"
			})]);
		case "ITEM_DISCOVERY_STARTED":
			if (!findTeam(job, event.teamId)) return rejected(job, event, "team is not part of this run");
			return settle({
				...job,
				state: "discoveringItems",
				activeTeamId: event.teamId,
				currentAction: `Scanning designs in "${findTeam(job, event.teamId)?.displayName ?? event.teamId}"`
			}, ctx, [buildLogDraft(job, {
				action: "discoverItems",
				message: "Item discovery started",
				resultStatus: "started",
				teamId: event.teamId
			})]);
		case "ITEMS_DISCOVERED": {
			if (!findTeam(job, event.teamId)) return rejected(job, event, "team is not part of this run");
			const previous = new Map(itemsForTeam(job, event.teamId).map((item) => [item.internalId, item]));
			const deduped = /* @__PURE__ */ new Map();
			for (const incoming of event.items) {
				const prior = previous.get(incoming.internalId);
				if (prior) deduped.set(incoming.internalId, {
					...prior,
					title: incoming.title,
					sourceUrl: incoming.sourceUrl ?? prior.sourceUrl,
					folderPath: incoming.folderPath ?? prior.folderPath,
					ownerLabel: incoming.ownerLabel ?? prior.ownerLabel,
					ownerConfidence: incoming.ownerConfidence,
					copyCapability: incoming.copyCapability === "unknown" ? prior.copyCapability : incoming.copyCapability,
					riskFlags: Array.from(/* @__PURE__ */ new Set([...prior.riskFlags, ...incoming.riskFlags]))
				});
				else deduped.set(incoming.internalId, incoming);
			}
			const others = job.items.filter((item) => item.sourceTeamId !== event.teamId);
			const rediscovered = [...deduped.values()];
			const dropped = [...previous.keys()].filter((id) => !deduped.has(id)).length;
			return settle({
				...job,
				items: [...others, ...rediscovered],
				currentAction: null
			}, ctx, [buildLogDraft(job, {
				action: "discoverItems",
				message: `Discovered ${rediscovered.length} item(s)`,
				resultStatus: "success",
				teamId: event.teamId,
				detail: dropped > 0 ? `${dropped} previously seen item(s) no longer listed` : null
			})]);
		}
		case "ITEM_DISCOVERY_FAILED": return settle({
			...job,
			currentAction: null,
			blocker: event.error,
			state: "paused",
			pauseReason: event.error.message
		}, ctx, [buildLogDraft(job, {
			action: "discoverItems",
			message: `Item discovery failed: ${event.error.message}`,
			resultStatus: "failure",
			teamId: event.teamId,
			error: event.error
		})]);
		case "ITEM_CAPABILITY_PROBED":
			if (!findItem(job, event.itemId)) return rejected(job, event, "unknown item");
			return settle(mapItem(job, event.itemId, (current) => {
				let flags = withoutFlag(current, "copyActionUnknown");
				if (event.capability === "unavailable") flags = withFlag(flags, "copyActionMissing");
				if (event.capability === "unknown") flags = withFlag(flags, "copyActionUnknown");
				return {
					...current,
					copyCapability: event.capability,
					riskFlags: flags
				};
			}), ctx, [buildLogDraft(job, {
				action: "probeCopyCapability",
				message: `Copy capability: ${event.capability}`,
				resultStatus: "info",
				itemId: event.itemId,
				detail: event.detail ?? null
			})]);
		case "DISCOVERY_COMPLETED": return settle({
			...job,
			state: "reviewReady",
			activeTeamId: null,
			currentAction: null
		}, ctx, [buildLogDraft(job, {
			action: "discovery",
			message: `Discovery complete: ${job.items.length} item(s) across ${job.sourceTeams.length} team(s)`,
			resultStatus: "success"
		})]);
		case "ITEM_INCLUSION_SET":
			if (!findItem(job, event.itemId)) return rejected(job, event, "unknown item");
			if (isExecuting(job.state)) return rejected(job, event, "pause the run before changing which items are included");
			return settle(mapItem(job, event.itemId, (current) => ({
				...current,
				selected: event.selected,
				state: event.selected && current.state === "discovered" ? "discovered" : current.state
			})), ctx, [buildLogDraft(job, {
				action: "setInclusion",
				message: event.selected ? "Item included" : "Item excluded",
				resultStatus: "info",
				itemId: event.itemId
			})]);
		case "CONFIRMATION_GRANTED":
			if (job.confirmations.scopes.includes(event.scope)) return {
				job,
				logs: []
			};
			return settle({
				...job,
				confirmations: {
					...job.confirmations,
					scopes: [...job.confirmations.scopes, event.scope]
				}
			}, ctx, [buildLogDraft(job, {
				action: "confirm",
				message: `Confirmation granted: ${event.scope}`,
				resultStatus: "info"
			})]);
		case "CONFIRMATION_REVOKED": return settle({
			...job,
			confirmations: {
				...job.confirmations,
				scopes: job.confirmations.scopes.filter((scope) => scope !== event.scope)
			}
		}, ctx, [buildLogDraft(job, {
			action: "confirm",
			message: `Confirmation revoked: ${event.scope}`,
			resultStatus: "info"
		})]);
		case "LEAVE_CONFIRMED":
			if (!findTeam(job, event.teamId)) return rejected(job, event, "team is not part of this run");
			if (job.confirmations.leaveConfirmedTeamIds.includes(event.teamId)) return {
				job,
				logs: []
			};
			return settle({
				...job,
				confirmations: {
					...job.confirmations,
					leaveConfirmedTeamIds: [...job.confirmations.leaveConfirmedTeamIds, event.teamId]
				}
			}, ctx, [buildLogDraft(job, {
				action: "confirmLeave",
				message: "Leaving this team was confirmed by the operator",
				resultStatus: "info",
				teamId: event.teamId
			})]);
		case "OVERRIDES_SET": {
			if (isExecuting(job.state)) return rejected(job, event, "pause the run before changing overrides");
			const overrides = {
				...job.userOverrides,
				...event.overrides
			};
			const changed = Object.entries(overrides).filter(([key, value]) => job.userOverrides[key] !== value).map(([key, value]) => `${key}=${String(value)}`);
			return settle({
				...job,
				userOverrides: overrides
			}, ctx, [buildLogDraft(job, {
				action: "setOverrides",
				message: changed.length > 0 ? `Advanced overrides changed: ${changed.join(", ")}` : "Overrides unchanged",
				resultStatus: "info",
				level: changed.length > 0 ? "warn" : "info"
			})]);
		}
		case "START_REQUESTED": {
			if (job.mode === "dryRun") return rejected(job, event, "dry run has no execution phase; it finishes at the review summary");
			if (isExecuting(job.state)) return rejected(job, event, "run is already executing");
			const guard = canStartRun(job);
			if (!guard.allowed) return rejected(job, event, guard.reason);
			return settle({
				...job,
				state: "copying",
				startedAt: job.startedAt ?? ctx.now,
				pauseReason: null,
				blocker: null,
				consecutiveFailures: 0
			}, ctx, [buildLogDraft(job, {
				action: "startRun",
				message: `Run started in mode "${job.mode}" for ${job.counters.itemsSelected} item(s)`,
				resultStatus: "started",
				detail: `destination=${job.destination?.displayName ?? "none"}; overrides=${JSON.stringify(job.userOverrides)}`
			})]);
		}
		case "TEAM_STARTED":
			if (!findTeam(job, event.teamId)) return rejected(job, event, "team is not part of this run");
			return settle({
				...job,
				activeTeamId: event.teamId,
				teamQueue: job.teamQueue.filter((id) => id !== event.teamId),
				state: "copying"
			}, ctx, [buildLogDraft(job, {
				action: "startTeam",
				message: "Started processing team",
				resultStatus: "started",
				teamId: event.teamId
			})]);
		case "COPY_STARTED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			if (!modeAllowsCopy(job.mode)) return rejected(job, event, "dry run never copies");
			if (!item.selected) return rejected(job, event, "item is excluded from this run");
			if (item.copyStatus === "copied") return rejected(job, event, "item was already copied");
			return settle(mapItem({
				...job,
				state: "copying",
				activeItemId: event.itemId,
				currentAction: `Copying "${item.title}"`
			}, event.itemId, (current) => ({
				...current,
				state: "copyInProgress",
				copyStatus: "inProgress",
				attempts: {
					...current.attempts,
					copy: current.attempts.copy + 1
				}
			})), ctx, [buildLogDraft(job, {
				action: "copyItem",
				message: `Copy attempt ${item.attempts.copy + 1} for "${item.title}"`,
				resultStatus: "started",
				itemId: event.itemId
			})]);
		}
		case "COPY_SUCCEEDED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			const finishesHere = !modeAllowsVerify(job.mode);
			return settle(mapItem({
				...job,
				consecutiveFailures: 0
			}, event.itemId, (current) => ({
				...current,
				copyStatus: "copied",
				state: finishesHere ? "completed" : "copied",
				copyConfirmationSeen: event.sawConfirmation ?? false,
				lastError: null,
				notes: appendNote(current, `Copied to ${job.destination?.displayName ?? "destination"} at ${ctx.now}`)
			})), ctx, [buildLogDraft(job, {
				action: "copyItem",
				message: `Copied "${item.title}"`,
				resultStatus: "success",
				itemId: event.itemId,
				detail: event.detail ?? null
			})]);
		}
		case "COPY_FAILED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			return settle(mapItem({
				...job,
				consecutiveFailures: job.consecutiveFailures + 1,
				currentAction: null
			}, event.itemId, (current) => ({
				...current,
				state: "copyFailed",
				copyStatus: "failed",
				lastError: event.error,
				notes: appendNote(current, `Copy failed: ${event.error.message}`)
			})), ctx, [buildLogDraft(job, {
				action: "copyItem",
				message: `Copy failed for "${item.title}": ${event.error.message}`,
				resultStatus: "failure",
				itemId: event.itemId,
				error: event.error
			})]);
		}
		case "VERIFY_STARTED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			if (item.copyStatus !== "copied") return rejected(job, event, "nothing to verify until the copy succeeds");
			return settle(mapItem({
				...job,
				state: "verifying",
				activeItemId: event.itemId,
				currentAction: `Verifying copy of "${item.title}"`
			}, event.itemId, (current) => ({
				...current,
				attempts: {
					...current.attempts,
					verify: current.attempts.verify + 1
				}
			})), ctx, [buildLogDraft(job, {
				action: "verifyCopy",
				message: `Verifying copy of "${item.title}"`,
				resultStatus: "started",
				itemId: event.itemId
			})]);
		}
		case "VERIFY_SUCCEEDED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			if (item.copyStatus !== "copied") return rejected(job, event, "cannot verify an item that was not copied");
			const finishesHere = !modeAllowsTrash(job.mode);
			return settle(mapItem({
				...job,
				consecutiveFailures: 0
			}, event.itemId, (current) => ({
				...current,
				verificationStatus: event.level,
				state: finishesHere ? "completed" : "copyVerified",
				lastError: null,
				notes: appendNote(current, `Verification (${event.level}): ${event.detail ?? "confirmed"}`)
			})), ctx, [buildLogDraft(job, {
				action: "verifyCopy",
				message: `Copy verified (${event.level}) for "${item.title}"`,
				resultStatus: "success",
				itemId: event.itemId,
				verificationLevel: event.level,
				detail: event.detail ?? null
			})]);
		}
		case "VERIFY_FAILED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			return settle(mapItem({
				...job,
				consecutiveFailures: job.consecutiveFailures + 1,
				currentAction: null
			}, event.itemId, (current) => ({
				...current,
				verificationStatus: "failed",
				state: "manualReviewRequired",
				lastError: event.error,
				notes: appendNote(current, `Verification failed: ${event.error.message}. Original left in place.`)
			})), ctx, [buildLogDraft(job, {
				action: "verifyCopy",
				message: `Could not verify copy of "${item.title}". Original left in place.`,
				resultStatus: "failure",
				itemId: event.itemId,
				verificationLevel: "failed",
				error: event.error
			})]);
		}
		case "TRASH_STARTED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			const guard = canTrashItem(job, item);
			if (!guard.allowed) {
				const blocked = normalizeError({
					category: guard.category,
					message: `Refused to trash "${item.title}"`,
					detail: guard.reason
				});
				return settle(mapItem(job, event.itemId, (current) => ({
					...current,
					state: "manualReviewRequired",
					deleteStatus: "blocked",
					lastError: blocked,
					notes: appendNote(current, `Trash blocked: ${guard.reason}`)
				})), ctx, [buildLogDraft(job, {
					action: "trashItem",
					message: `Refused to trash "${item.title}": ${guard.reason}`,
					resultStatus: "blocked",
					itemId: event.itemId,
					level: "error",
					error: blocked
				})]);
			}
			return settle(mapItem({
				...job,
				state: "trashing",
				activeItemId: event.itemId,
				currentAction: `Moving original of "${item.title}" to trash`
			}, event.itemId, (current) => ({
				...current,
				state: "deleteInProgress",
				deleteStatus: "inProgress",
				attempts: {
					...current.attempts,
					trash: current.attempts.trash + 1
				}
			})), ctx, [buildLogDraft(job, {
				action: "trashItem",
				message: `Moving original of "${item.title}" to trash (verification: ${item.verificationStatus})`,
				resultStatus: "started",
				itemId: event.itemId
			})]);
		}
		case "TRASH_SUCCEEDED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			return settle(mapItem({
				...job,
				consecutiveFailures: 0
			}, event.itemId, (current) => ({
				...current,
				deleteStatus: "trashed",
				state: "completed",
				lastError: null,
				notes: appendNote(current, `Original moved to trash at ${ctx.now}`)
			})), ctx, [buildLogDraft(job, {
				action: "trashItem",
				message: `Original of "${item.title}" moved to trash`,
				resultStatus: "success",
				itemId: event.itemId,
				detail: event.detail ?? null
			})]);
		}
		case "TRASH_FAILED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			return settle(mapItem({
				...job,
				consecutiveFailures: job.consecutiveFailures + 1,
				currentAction: null
			}, event.itemId, (current) => ({
				...current,
				deleteStatus: "failed",
				state: "deleteFailed",
				lastError: event.error,
				notes: appendNote(current, `Trash failed: ${event.error.message}`)
			})), ctx, [buildLogDraft(job, {
				action: "trashItem",
				message: `Could not trash original of "${item.title}": ${event.error.message}`,
				resultStatus: "failure",
				itemId: event.itemId,
				error: event.error
			})]);
		}
		case "ITEM_SKIPPED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			return settle(mapItem({
				...job,
				activeItemId: null
			}, event.itemId, (current) => ({
				...current,
				state: "skipped",
				copyStatus: current.copyStatus === "pending" || current.copyStatus === "inProgress" ? "skipped" : current.copyStatus,
				notes: appendNote(current, `Skipped: ${event.reason}`)
			})), ctx, [buildLogDraft(job, {
				action: "skipItem",
				message: `Skipped "${item.title}": ${event.reason}`,
				resultStatus: "skipped",
				itemId: event.itemId
			})]);
		}
		case "ITEM_RETRY_REQUESTED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			if (itemNeedsWork(item)) return rejected(job, event, "item is already queued for work");
			const reset = item.copyStatus !== "copied" ? {
				...item,
				state: "copyPending",
				copyStatus: "pending",
				deleteStatus: "notRequested"
			} : !isVerified(item) ? {
				...item,
				state: "copied",
				verificationStatus: "unverified"
			} : {
				...item,
				state: "copyVerified",
				deleteStatus: "pending"
			};
			const nextJob = mapItem({
				...job,
				consecutiveFailures: 0,
				blocker: null
			}, event.itemId, () => ({
				...reset,
				selected: true,
				lastError: null,
				notes: appendNote(item, "Retry requested by operator")
			}));
			/**
			* Retrying after the run finished reopens it, otherwise the retry would be
			* queued into a terminal run and never execute. The item's team stops
			* counting as processed until it is worked through again.
			*/
			const reopening = isTerminal(job.state);
			return settle(reopening ? {
				...nextJob,
				state: "copying",
				endedAt: null,
				activeTeamId: item.sourceTeamId,
				processedTeamIds: nextJob.processedTeamIds.filter((id) => id !== item.sourceTeamId)
			} : nextJob, ctx, [buildLogDraft(job, {
				action: "retryItem",
				message: reopening ? `Retry queued for "${item.title}"; the finished run was reopened` : `Retry queued for "${item.title}"`,
				resultStatus: "info",
				itemId: event.itemId
			})]);
		}
		case "MANUAL_ASSIST_REQUESTED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			return settle({
				...job,
				state: "paused",
				pauseReason: `Manual step needed for "${item.title}"`,
				manualAssist: {
					itemId: event.itemId,
					step: event.step,
					instruction: event.instruction,
					raisedAt: ctx.now
				},
				currentAction: event.instruction
			}, ctx, [buildLogDraft(job, {
				action: "manualAssist",
				message: `Manual assist requested (${event.step}) for "${item.title}"`,
				resultStatus: "info",
				level: "warn",
				itemId: event.itemId,
				detail: event.instruction
			})]);
		}
		case "MANUAL_ASSIST_RESOLVED": {
			const item = findItem(job, event.itemId);
			if (!item) return rejected(job, event, "unknown item");
			if (job.manualAssist?.itemId !== event.itemId) return rejected(job, event, "no manual assist pending for this item");
			const step = job.manualAssist.step;
			if (event.outcome === "skip") return settle(mapItem({
				...job,
				manualAssist: null,
				state: resolveResumeState(job),
				pauseReason: null
			}, event.itemId, (current) => ({
				...current,
				state: "skipped",
				notes: appendNote(current, `Manual ${step} declined by operator`)
			})), ctx, [buildLogDraft(job, {
				action: "manualAssist",
				message: `Operator skipped manual ${step} for "${item.title}"`,
				resultStatus: "skipped",
				itemId: event.itemId
			})]);
			const applied = mapItem({
				...job,
				manualAssist: null,
				pauseReason: null,
				consecutiveFailures: 0
			}, event.itemId, (current) => {
				if (step === "copy") return {
					...current,
					copyStatus: "copied",
					verificationStatus: "manual",
					state: modeAllowsTrash(job.mode) ? "copyVerified" : "completed",
					notes: appendNote(current, "Operator confirmed the copy manually")
				};
				if (step === "verify") return {
					...current,
					verificationStatus: "manual",
					state: modeAllowsTrash(job.mode) ? "copyVerified" : "completed",
					notes: appendNote(current, "Operator verified the copy manually")
				};
				return {
					...current,
					deleteStatus: "trashed",
					state: "completed",
					notes: appendNote(current, "Operator trashed the original manually")
				};
			});
			return settle({
				...applied,
				state: resolveResumeState(applied)
			}, ctx, [buildLogDraft(job, {
				action: "manualAssist",
				message: `Operator confirmed manual ${step} for "${item.title}"`,
				resultStatus: "success",
				itemId: event.itemId,
				verificationLevel: step === "trash" ? null : "manual"
			})]);
		}
		case "TEAM_ITEMS_EXHAUSTED": {
			if (job.activeTeamId !== event.teamId) return rejected(job, event, "team is not the active team");
			const needsLeave = modeAllowsLeave(job.mode) && !job.leftTeamIds.includes(event.teamId);
			return settle({
				...job,
				activeItemId: null,
				currentAction: null,
				state: needsLeave ? "awaitingLeaveConfirmation" : job.state
			}, ctx, [buildLogDraft(job, {
				action: "teamItemsExhausted",
				message: needsLeave ? "All items processed. Waiting for leave confirmation." : "All items processed for this team.",
				resultStatus: "info",
				teamId: event.teamId
			})]);
		}
		case "LEAVE_STARTED": {
			const guard = canLeaveTeam(job, event.teamId);
			if (!guard.allowed) return rejected(job, event, guard.reason);
			const team = findTeam(job, event.teamId);
			return settle({
				...job,
				state: "leavingTeam",
				currentAction: `Leaving "${team?.displayName ?? event.teamId}"`
			}, ctx, [buildLogDraft(job, {
				action: "leaveTeam",
				message: "Leave action started",
				resultStatus: "started",
				teamId: event.teamId
			})]);
		}
		case "LEAVE_SUCCEEDED": {
			const team = findTeam(job, event.teamId);
			if (!team) return rejected(job, event, "team is not part of this run");
			return settle({
				...job,
				leftTeamIds: job.leftTeamIds.includes(event.teamId) ? job.leftTeamIds : [...job.leftTeamIds, event.teamId],
				sourceTeams: job.sourceTeams.map((candidate) => candidate.internalId === event.teamId ? {
					...candidate,
					leaveSupportedState: "available"
				} : candidate),
				currentAction: null,
				consecutiveFailures: 0
			}, ctx, [buildLogDraft(job, {
				action: "leaveTeam",
				message: `Left team "${team.displayName}"`,
				resultStatus: "success",
				teamId: event.teamId
			})]);
		}
		case "LEAVE_FAILED": {
			const team = findTeam(job, event.teamId);
			if (!team) return rejected(job, event, "team is not part of this run");
			const blockedByPolicy = event.error.category === "leave_blocked_by_policy";
			return settle({
				...job,
				sourceTeams: job.sourceTeams.map((candidate) => candidate.internalId === event.teamId ? {
					...candidate,
					leaveSupportedState: blockedByPolicy ? "blockedByPolicy" : candidate.leaveSupportedState
				} : candidate),
				confirmations: {
					...job.confirmations,
					leaveConfirmedTeamIds: job.confirmations.leaveConfirmedTeamIds.filter((id) => id !== event.teamId)
				},
				state: "awaitingLeaveConfirmation",
				currentAction: null,
				blocker: blockedByPolicy ? job.blocker : event.error
			}, ctx, [buildLogDraft(job, {
				action: "leaveTeam",
				message: `Could not leave "${team.displayName}": ${event.error.message}`,
				resultStatus: blockedByPolicy ? "blocked" : "failure",
				teamId: event.teamId,
				error: event.error
			})]);
		}
		case "TEAM_COMPLETED":
			if (!findTeam(job, event.teamId)) return rejected(job, event, "team is not part of this run");
			return settle({
				...job,
				processedTeamIds: job.processedTeamIds.includes(event.teamId) ? job.processedTeamIds : [...job.processedTeamIds, event.teamId],
				teamQueue: job.teamQueue.filter((id) => id !== event.teamId),
				activeTeamId: job.activeTeamId === event.teamId ? null : job.activeTeamId,
				activeItemId: null,
				currentAction: null
			}, ctx, [buildLogDraft(job, {
				action: "teamCompleted",
				message: "Finished processing team",
				resultStatus: "success",
				teamId: event.teamId
			})]);
		case "RUN_RECOVERED": {
			/**
			* Recovery bias: an interrupted copy is safe to redo (a duplicate in the
			* destination is recoverable), but an interrupted trash needs human eyes
			* because we cannot tell whether it landed.
			*/
			const logs = [];
			const items = job.items.map((item) => {
				if (item.state === "copyInProgress") {
					logs.push(buildLogDraft(job, {
						action: "recover",
						message: `Requeued "${item.title}" for copy after an interrupted attempt`,
						resultStatus: "info",
						level: "warn",
						itemId: item.internalId,
						detail: event.reason
					}));
					return {
						...item,
						state: "copyPending",
						copyStatus: "pending",
						notes: appendNote(item, `Copy was interrupted (${event.reason}); requeued. Check for a duplicate copy.`)
					};
				}
				if (item.state === "deleteInProgress") {
					logs.push(buildLogDraft(job, {
						action: "recover",
						message: `"${item.title}" needs review: a trash action was interrupted`,
						resultStatus: "blocked",
						level: "error",
						itemId: item.internalId,
						detail: event.reason
					}));
					return {
						...item,
						state: "manualReviewRequired",
						deleteStatus: "blocked",
						lastError: normalizeError({
							category: "delete_failed",
							message: "A move-to-trash action was interrupted",
							detail: `${event.reason}. Check whether the original is in the source team or in Canva's trash.`
						}),
						notes: appendNote(item, `Trash was interrupted (${event.reason}); parked for review.`)
					};
				}
				return item;
			});
			const state = isExecuting(job.state) ? "paused" : job.state;
			logs.push(buildLogDraft(job, {
				action: "recover",
				message: `Run state recovered: ${event.reason}`,
				resultStatus: "info",
				level: "warn"
			}));
			return settle({
				...job,
				items,
				state,
				pauseReason: state === "paused" ? `Recovered: ${event.reason}` : job.pauseReason,
				currentAction: null
			}, ctx, logs);
		}
		case "CURRENT_ACTION_SET":
			if (job.currentAction === event.text) return {
				job,
				logs: []
			};
			return {
				job: {
					...job,
					currentAction: event.text,
					updatedAt: ctx.now
				},
				logs: []
			};
		case "PAUSE_REQUESTED":
			if (isTerminal(job.state)) return rejected(job, event, "run already finished");
			if (job.state === "paused") return {
				job,
				logs: []
			};
			return settle({
				...job,
				state: "paused",
				pauseReason: event.reason ?? "Paused by operator",
				currentAction: null
			}, ctx, [buildLogDraft(job, {
				action: "pauseRun",
				message: `Run paused: ${event.reason ?? "operator request"}`,
				resultStatus: "info",
				level: "warn"
			})]);
		case "RESUME_REQUESTED":
			if (job.state !== "paused" && job.state !== "blocked") return rejected(job, event, `cannot resume from state "${job.state}"`);
			if (job.manualAssist) return rejected(job, event, "resolve the pending manual step first");
			return settle({
				...job,
				state: resolveResumeState(job),
				pauseReason: null,
				blocker: null,
				consecutiveFailures: 0
			}, ctx, [buildLogDraft(job, {
				action: "resumeRun",
				message: "Run resumed",
				resultStatus: "info"
			})]);
		case "STOP_REQUESTED": {
			if (isTerminal(job.state)) return {
				job,
				logs: []
			};
			const state = finishState(job);
			return settle({
				...job,
				state,
				endedAt: ctx.now,
				currentAction: null,
				activeItemId: null,
				pauseReason: null
			}, ctx, [buildLogDraft(job, {
				action: "stopRun",
				message: "Run stopped by operator",
				resultStatus: "info",
				level: "warn"
			})]);
		}
		case "RUN_BLOCKED": return settle({
			...job,
			state: "blocked",
			blocker: event.error,
			currentAction: null
		}, ctx, [buildLogDraft(job, {
			action: "blockRun",
			message: `Run halted: ${event.error.message}`,
			resultStatus: "blocked",
			level: "error",
			error: event.error
		})]);
		case "RUN_FINISHED": {
			if (isTerminal(job.state)) return {
				job,
				logs: []
			};
			const state = finishState(job);
			return settle({
				...job,
				state,
				endedAt: ctx.now,
				currentAction: null,
				activeItemId: null
			}, ctx, [buildLogDraft(job, {
				action: "finishRun",
				message: state === "completed" ? "Run completed" : "Run completed with warnings",
				resultStatus: state === "completed" ? "success" : "info",
				level: state === "completed" ? "info" : "warn"
			})]);
		}
		default: return rejected(job, event, "unhandled event type");
	}
}
/** Applies a sequence of events, threading the job through each one. */
function reduceAll(job, events, ctx) {
	return events.reduce((accumulator, event) => {
		const next = reduceRun(accumulator.job, event, ctx);
		return {
			job: next.job,
			logs: [...accumulator.logs, ...next.logs]
		};
	}, {
		job,
		logs: []
	});
}
//#endregion
export { ERROR_CATEGORIES as a, toNormalizedError as c, reduceAll as i, isPreRun as n, isHaltingCategory as o, isTerminal as r, normalizeError as s, isExecuting as t };

//# sourceMappingURL=run-state-machine.js.map