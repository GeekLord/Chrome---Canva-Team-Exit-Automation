//#region src/shared/constants.ts
/**
* Project-wide constants. Nothing in here may contain a DOM selector; those all
* live in the versioned selector map under `src/content/selector-map.ts`.
*/
var EXTENSION_NAME = "Canva Team Exit Automation";
var CANVA_ORIGIN = "https://www.canva.com";
/** Host permission pattern, kept in sync with `public/manifest.json`. */
var CANVA_URL_PATTERN = "https://www.canva.com/*";
/**
* Candidate paths for the "all projects" listing. Canva has moved this route
* before, so the navigator tries them in order and keeps the first that renders
* a recognisable item grid.
*/
var CANVA_PROJECT_LIST_PATHS = ["/folder/all-projects", "/projects"];
var EXECUTION_MODES = [
	"dryRun",
	"copyOnly",
	"copyVerify",
	"copyVerifyTrash",
	"copyVerifyTrashLeave"
];
var EXECUTION_MODE_LABELS = {
	dryRun: "Dry run (no changes)",
	copyOnly: "Copy only",
	copyVerify: "Copy + verify",
	copyVerifyTrash: "Copy + verify + trash originals",
	copyVerifyTrashLeave: "Copy + verify + trash + leave team"
};
var EXECUTION_MODE_DESCRIPTIONS = {
	dryRun: "Scans teams and items and probes which actions look automatable. Never changes anything in Canva.",
	copyOnly: "Copies each selected item to the destination. Skips verification, trashing and leaving.",
	copyVerify: "Copies each item and records how strongly the copy could be verified. Nothing is trashed.",
	copyVerifyTrash: "Copies, verifies, then moves verified originals to trash in the source team.",
	copyVerifyTrashLeave: "Full exit: copy, verify, trash originals, then leave the team when eligible."
};
var MAX_ACTION_DELAY_MS = 3e4;
/** Default per-action timeout for a single DOM interaction. */
var DEFAULT_ACTION_TIMEOUT_MS = 15e3;
/** How long discovery may scroll a lazy-loading list before giving up. */
var DEFAULT_DISCOVERY_TIMEOUT_MS = 9e4;
var LOG_RETENTION_MAX_EVENTS = 2e4;
//#endregion
//#region src/shared/ids.ts
/**
* Id helpers. `crypto.randomUUID` exists in the service worker, extension pages
* and content scripts on the Chrome versions this extension targets; the
* fallback only matters for non-secure test contexts.
*/
function randomSuffix() {
	const globalCrypto = globalThis.crypto;
	if (globalCrypto && typeof globalCrypto.randomUUID === "function") return globalCrypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function newRunId() {
	return `run_${randomSuffix()}`;
}
function newEventId() {
	return `evt_${randomSuffix()}`;
}
//#endregion
//#region src/shared/settings.ts
/**
* Defaults for a fresh browser profile.
*
* Dry run is the default mode and `liveExecutionEnabled` is false, so a first
* run cannot change anything in Canva until the user deliberately opts in and
* accepts the disclosure.
*/
var DEFAULT_SETTINGS = {
	version: 1,
	liveExecutionEnabled: false,
	disclosureAcceptedAt: null,
	defaultMode: "dryRun",
	defaultDestinationTeamId: null,
	actionDelayMs: 1200,
	actionJitterMs: 700,
	actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
	discoveryTimeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS,
	maxRetriesPerAction: 2,
	backoffMultiplier: 2,
	circuitBreakerThreshold: 5,
	confirmationItemThreshold: 25,
	requireOwnedByMe: true,
	pauseBetweenTeams: true,
	probeItemLimitPerTeam: 10,
	manualAssistEnabled: true,
	debugMode: false,
	overrides: {
		allowTrashWithoutVerification: false,
		allowLeaveWithUnresolvedItems: false
	},
	logRetentionMaxEvents: 5e3
};
function clampNumber(value, min, max, fallback) {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
/**
* Enforces the pacing floor regardless of what is in storage. Even a hand-edited
* settings blob cannot make the extension click through Canva at machine speed.
*/
function clampSettings(settings) {
	return {
		...settings,
		actionDelayMs: clampNumber(settings.actionDelayMs, 400, MAX_ACTION_DELAY_MS, DEFAULT_SETTINGS.actionDelayMs),
		actionJitterMs: clampNumber(settings.actionJitterMs, 0, MAX_ACTION_DELAY_MS, DEFAULT_SETTINGS.actionJitterMs),
		actionTimeoutMs: clampNumber(settings.actionTimeoutMs, 2e3, 12e4, DEFAULT_SETTINGS.actionTimeoutMs),
		discoveryTimeoutMs: clampNumber(settings.discoveryTimeoutMs, 5e3, 6e5, DEFAULT_SETTINGS.discoveryTimeoutMs),
		maxRetriesPerAction: Math.round(clampNumber(settings.maxRetriesPerAction, 0, 10, DEFAULT_SETTINGS.maxRetriesPerAction)),
		backoffMultiplier: clampNumber(settings.backoffMultiplier, 1, 10, DEFAULT_SETTINGS.backoffMultiplier),
		circuitBreakerThreshold: Math.round(clampNumber(settings.circuitBreakerThreshold, 1, 100, DEFAULT_SETTINGS.circuitBreakerThreshold)),
		confirmationItemThreshold: Math.round(clampNumber(settings.confirmationItemThreshold, 1, 1e4, DEFAULT_SETTINGS.confirmationItemThreshold)),
		logRetentionMaxEvents: Math.round(clampNumber(settings.logRetentionMaxEvents, 100, LOG_RETENTION_MAX_EVENTS, DEFAULT_SETTINGS.logRetentionMaxEvents)),
		probeItemLimitPerTeam: Math.round(clampNumber(settings.probeItemLimitPerTeam, 0, 500, DEFAULT_SETTINGS.probeItemLimitPerTeam))
	};
}
/** True once the user has both accepted the disclosure and enabled live runs. */
function liveExecutionAllowed(settings) {
	return settings.liveExecutionEnabled && settings.disclosureAcceptedAt !== null;
}
//#endregion
//#region src/shared/factories.ts
/**
* Constructors for the canonical entities, plus counter derivation.
*
* Counters are always recomputed from `items`, never incremented in place, so a
* resumed or retried run cannot drift away from the truth.
*/
function emptyCounters() {
	return {
		teamsSelected: 0,
		teamsProcessed: 0,
		teamsLeft: 0,
		itemsFound: 0,
		itemsSelected: 0,
		copied: 0,
		verified: 0,
		trashed: 0,
		failed: 0,
		skipped: 0,
		manualReview: 0
	};
}
function createRunJob(input) {
	return {
		runId: input.runId ?? newRunId(),
		mode: input.mode,
		createdAt: input.now,
		startedAt: null,
		endedAt: null,
		sourceTeams: [],
		destination: null,
		counters: emptyCounters(),
		state: "idle",
		userOverrides: {
			allowTrashWithoutVerification: input.overrides?.allowTrashWithoutVerification ?? input.settings.overrides.allowTrashWithoutVerification,
			allowLeaveWithUnresolvedItems: input.overrides?.allowLeaveWithUnresolvedItems ?? input.settings.overrides.allowLeaveWithUnresolvedItems
		},
		settings: {
			confirmationItemThreshold: input.settings.confirmationItemThreshold,
			requireOwnedByMe: input.settings.requireOwnedByMe,
			selectorMapVersion: input.selectorMapVersion
		},
		items: [],
		teamQueue: [],
		processedTeamIds: [],
		leftTeamIds: [],
		activeTeamId: null,
		activeItemId: null,
		currentAction: null,
		confirmations: {
			scopes: [],
			leaveConfirmedTeamIds: []
		},
		pauseReason: null,
		blocker: null,
		consecutiveFailures: 0,
		manualAssist: null,
		updatedAt: input.now
	};
}
function createDestinationFromTeam(team) {
	return {
		kind: "sameLoginWorkspace",
		teamId: team.internalId,
		displayName: team.displayName,
		workspaceUrl: team.workspaceUrl
	};
}
function isVerified(item) {
	return item.verificationStatus === "strong" || item.verificationStatus === "weak" || item.verificationStatus === "manual";
}
/** Terminal item states: the engine will not pick these up again. */
function isItemResolved(item) {
	return item.state === "completed" || item.state === "skipped";
}
function recomputeCounters(job) {
	const selectedItems = job.items.filter((item) => item.selected);
	return {
		teamsSelected: job.sourceTeams.length,
		teamsProcessed: job.processedTeamIds.length,
		teamsLeft: job.leftTeamIds.length,
		itemsFound: job.items.length,
		itemsSelected: selectedItems.length,
		copied: job.items.filter((item) => item.copyStatus === "copied").length,
		verified: job.items.filter(isVerified).length,
		trashed: job.items.filter((item) => item.deleteStatus === "trashed").length,
		failed: job.items.filter((item) => item.state === "copyFailed" || item.state === "deleteFailed").length,
		skipped: job.items.filter((item) => item.state === "skipped").length,
		manualReview: job.items.filter((item) => item.state === "manualReviewRequired").length
	};
}
function withRecomputedCounters(job, now) {
	return {
		...job,
		counters: recomputeCounters(job),
		updatedAt: now
	};
}
function findItem(job, itemId) {
	return job.items.find((item) => item.internalId === itemId);
}
function findTeam(job, teamId) {
	return job.sourceTeams.find((team) => team.internalId === teamId);
}
function itemsForTeam(job, teamId) {
	return job.items.filter((item) => item.sourceTeamId === teamId);
}
function mapItem(job, itemId, update) {
	let touched = false;
	const items = job.items.map((item) => {
		if (item.internalId !== itemId) return item;
		touched = true;
		return update(item);
	});
	return touched ? {
		...job,
		items
	} : job;
}
//#endregion
//#region src/shared/guards.ts
var ALLOWED = { allowed: true };
function deny(reason, category = "unknown") {
	return {
		allowed: false,
		reason,
		category
	};
}
function modeAllowsCopy(mode) {
	return mode !== "dryRun";
}
function modeAllowsVerify(mode) {
	return mode === "copyVerify" || mode === "copyVerifyTrash" || mode === "copyVerifyTrashLeave";
}
function modeAllowsTrash(mode) {
	return mode === "copyVerifyTrash" || mode === "copyVerifyTrashLeave";
}
function modeAllowsLeave(mode) {
	return mode === "copyVerifyTrashLeave";
}
/** True for any mode that mutates Canva. Dry run must never reach an executor. */
function modeIsMutating(mode) {
	return mode !== "dryRun";
}
/**
* An original may only be trashed when its copy landed, and (unless the user set
* the explicit advanced override) when that copy was verified.
*/
function canTrashItem(job, item) {
	if (!modeAllowsTrash(job.mode)) return deny(`Run mode "${job.mode}" does not include trashing originals.`);
	if (item.copyStatus !== "copied") return deny(`Copy status is "${item.copyStatus}", so the original stays put. Nothing is trashed without a completed copy.`, "copy_verification_failed");
	if (!isVerified(item)) {
		if (job.userOverrides.allowTrashWithoutVerification) return ALLOWED;
		return deny("Copy was not verified. Enable the advanced override, verify manually, or skip the item.", "copy_verification_failed");
	}
	return ALLOWED;
}
/** Selected items that still need a decision before the team can be left. */
function unresolvedItemsForTeam(job, teamId) {
	return itemsForTeam(job, teamId).filter((item) => item.selected && !isItemResolved(item));
}
function canLeaveTeam(job, teamId) {
	if (!modeAllowsLeave(job.mode)) return deny(`Run mode "${job.mode}" does not include leaving the team.`);
	const team = job.sourceTeams.find((candidate) => candidate.internalId === teamId);
	if (!team) return deny(`Team ${teamId} is not part of this run.`);
	if (team.leaveSupportedState === "blockedByPolicy") return deny("Canva reports that leaving this team is not permitted for you.", "leave_blocked_by_policy");
	const unresolved = unresolvedItemsForTeam(job, teamId);
	if (unresolved.length > 0 && !job.userOverrides.allowLeaveWithUnresolvedItems) return deny(`${unresolved.length} selected item(s) are still unresolved. Resolve or skip them first, or set the advanced override.`);
	if (!job.confirmations.leaveConfirmedTeamIds.includes(teamId)) return deny(`Leaving "${team.displayName}" has not been confirmed yet.`);
	return ALLOWED;
}
/**
* Second-confirmation scopes this run needs before it may start.
* Dry runs need none.
*/
function requiredConfirmations(job) {
	const required = [];
	if (modeIsMutating(job.mode)) required.push("liveExecution");
	if (modeAllowsTrash(job.mode)) required.push("trash");
	if (modeAllowsLeave(job.mode)) required.push("leaveTeam");
	if (job.sourceTeams.length > 1) required.push("multiTeamBatch");
	if (job.items.filter((item) => item.selected).length > job.settings.confirmationItemThreshold) required.push("largeBatch");
	return required;
}
function missingConfirmations(job) {
	const granted = new Set(job.confirmations.scopes);
	return requiredConfirmations(job).filter((scope) => !granted.has(scope));
}
function canStartRun(job) {
	if (job.sourceTeams.length === 0) return deny("No source team selected.");
	if (job.items.filter((item) => item.selected).length === 0) return deny("No items are included in this run.");
	if (modeIsMutating(job.mode) && job.destination === null) return deny("Pick a copy destination before starting.", "destination_not_found");
	if (modeIsMutating(job.mode) && job.destination?.kind === "separateAccountShareCopy") return deny("Separate-account share-and-copy mode is not available in this version.");
	if (modeIsMutating(job.mode) && job.destination?.kind === "sameLoginWorkspace" && job.sourceTeams.some((team) => team.internalId === job.destination?.teamId)) return deny("The destination cannot also be a source team in the same run.");
	const missing = missingConfirmations(job);
	if (missing.length > 0) return deny(`Awaiting confirmation: ${missing.join(", ")}.`);
	return ALLOWED;
}
/** True when the engine still has work to do on this item. */
function itemNeedsWork(item) {
	if (!item.selected) return false;
	if (isItemResolved(item)) return false;
	if (item.state === "copyFailed" || item.state === "deleteFailed" || item.state === "manualReviewRequired") return false;
	return true;
}
function nextItemNeedingWork(job, teamId) {
	return itemsForTeam(job, teamId).find((item) => itemNeedsWork(item));
}
/** Items that block the end-of-run "all clear" summary. */
function blockingItems(job) {
	return job.items.filter((item) => item.selected && (item.state === "copyFailed" || item.state === "deleteFailed" || item.state === "manualReviewRequired"));
}
//#endregion
//#region src/shared/report.ts
function buildRunReport(job) {
	const verificationBreakdown = {
		unverified: 0,
		strong: 0,
		weak: 0,
		manual: 0,
		failed: 0
	};
	for (const item of job.items) {
		if (!item.selected) continue;
		verificationBreakdown[item.verificationStatus] += 1;
	}
	const teams = job.sourceTeams.map((team) => {
		const items = itemsForTeam(job, team.internalId).filter((item) => item.selected);
		return {
			teamId: team.internalId,
			displayName: team.displayName,
			itemsSelected: items.length,
			copied: items.filter((item) => item.copyStatus === "copied").length,
			verified: items.filter((item) => item.verificationStatus === "strong" || item.verificationStatus === "weak" || item.verificationStatus === "manual").length,
			trashed: items.filter((item) => item.deleteStatus === "trashed").length,
			left: job.leftTeamIds.includes(team.internalId),
			leaveState: team.leaveSupportedState,
			unresolved: items.filter((item) => item.state !== "completed" && item.state !== "skipped").length
		};
	});
	const blockingIssues = blockingItems(job).map((item) => ({
		itemId: item.internalId,
		title: item.title,
		teamName: job.sourceTeams.find((team) => team.internalId === item.sourceTeamId)?.displayName ?? item.sourceTeamId,
		state: item.state,
		category: item.lastError?.category ?? null,
		message: item.lastError?.message ?? "Unresolved",
		nextStep: item.lastError?.nextStep ?? null
	}));
	const durationMs = job.startedAt && job.endedAt ? new Date(job.endedAt).getTime() - new Date(job.startedAt).getTime() : null;
	return {
		runId: job.runId,
		mode: job.mode,
		state: job.state,
		createdAt: job.createdAt,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		durationMs: durationMs !== null && Number.isFinite(durationMs) ? durationMs : null,
		destination: job.destination?.displayName ?? null,
		teamsSelected: job.counters.teamsSelected,
		teamsProcessed: job.counters.teamsProcessed,
		teamsLeft: job.counters.teamsLeft,
		itemsFound: job.counters.itemsFound,
		itemsSelected: job.counters.itemsSelected,
		copied: job.counters.copied,
		verified: job.counters.verified,
		trashed: job.counters.trashed,
		failed: job.counters.failed,
		skipped: job.counters.skipped,
		manualReview: job.counters.manualReview,
		verificationBreakdown,
		teams,
		blockingIssues,
		blocker: job.blocker,
		overrides: job.userOverrides,
		selectorMapVersion: job.settings.selectorMapVersion
	};
}
function buildDryRunSummary(job) {
	const selectedItems = job.items.filter((item) => item.selected);
	return {
		totalFound: job.items.length,
		selected: selectedItems.length,
		copyable: selectedItems.filter((item) => item.copyCapability === "available").length,
		blocked: selectedItems.filter((item) => item.copyCapability === "unavailable").length,
		ambiguous: selectedItems.filter((item) => item.copyCapability === "unknown" || item.ownerConfidence === "unknown" || item.ownerConfidence === "low").length,
		byTeam: job.sourceTeams.map((team) => {
			const items = itemsForTeam(job, team.internalId);
			const selected = items.filter((item) => item.selected);
			return {
				teamId: team.internalId,
				displayName: team.displayName,
				found: items.length,
				selected: selected.length,
				copyable: selected.filter((item) => item.copyCapability === "available").length
			};
		})
	};
}
//#endregion
export { CANVA_URL_PATTERN as A, withRecomputedCounters as C, newEventId as D, liveExecutionAllowed as E, EXTENSION_NAME as F, EXECUTION_MODES as M, EXECUTION_MODE_DESCRIPTIONS as N, CANVA_ORIGIN as O, EXECUTION_MODE_LABELS as P, mapItem as S, clampSettings as T, createRunJob as _, canStartRun as a, isVerified as b, missingConfirmations as c, modeAllowsTrash as d, modeAllowsVerify as f, createDestinationFromTeam as g, unresolvedItemsForTeam as h, canLeaveTeam as i, DEFAULT_ACTION_TIMEOUT_MS as j, CANVA_PROJECT_LIST_PATHS as k, modeAllowsCopy as l, requiredConfirmations as m, buildRunReport as n, canTrashItem as o, nextItemNeedingWork as p, blockingItems as r, itemNeedsWork as s, buildDryRunSummary as t, modeAllowsLeave as u, findItem as v, DEFAULT_SETTINGS as w, itemsForTeam as x, findTeam as y };

//# sourceMappingURL=report.js.map