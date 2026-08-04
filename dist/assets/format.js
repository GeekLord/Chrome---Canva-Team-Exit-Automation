import { F as EXTENSION_NAME, n as buildRunReport } from "./report.js";
//#region \0vite/modulepreload-polyfill.js
(function polyfill() {
	const relList = document.createElement("link").relList;
	if (relList && relList.supports && relList.supports("modulepreload")) return;
	for (const link of document.querySelectorAll("link[rel=\"modulepreload\"]")) processPreload(link);
	new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type !== "childList") continue;
			for (const node of mutation.addedNodes) if (node.tagName === "LINK" && node.rel === "modulepreload") processPreload(node);
		}
	}).observe(document, {
		childList: true,
		subtree: true
	});
	function getFetchOpts(link) {
		const fetchOpts = {};
		if (link.integrity) fetchOpts.integrity = link.integrity;
		if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
		if (link.crossOrigin === "use-credentials") fetchOpts.credentials = "include";
		else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
		else fetchOpts.credentials = "same-origin";
		return fetchOpts;
	}
	function processPreload(link) {
		if (link.ep) return;
		link.ep = true;
		const fetchOpts = getFetchOpts(link);
		fetch(link.href, fetchOpts);
	}
})();
//#endregion
//#region src/logging/download.ts
/**
* Client-side file save for log exports.
*
* Uses a Blob URL plus an anchor click from an extension page, which needs no
* `downloads` permission and never sends the data anywhere.
*/
function downloadText(filename, mimeType, contents) {
	const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = "noopener";
	anchor.style.display = "none";
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1e4);
}
//#endregion
//#region src/logging/exporters.ts
/**
* Log exporters. Exports only ever run on an explicit user action, and the
* output stays on the user's machine: the popup turns these strings into a Blob
* and an anchor click, so no `downloads` permission and no network call.
*/
var LOG_CSV_COLUMNS = [
	"eventId",
	"runId",
	"timestamp",
	"level",
	"entityType",
	"entityId",
	"action",
	"sourceTeamId",
	"sourceTeamName",
	"itemTitle",
	"resultStatus",
	"verificationLevel",
	"errorCategory",
	"message",
	"detail",
	"screenshotRef"
];
/**
* Spreadsheet applications treat a leading `=`, `+`, `-` or `@` as a formula.
* Design titles are user-controlled text, so neutralise those.
*/
function neutralizeFormula(value) {
	return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
function escapeCsvCell(value) {
	if (value === null || value === void 0) return "";
	const raw = neutralizeFormula(String(value));
	if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, "\"\"")}"`;
	return raw;
}
function toCsv(events) {
	return [LOG_CSV_COLUMNS.join(","), ...events.map((event) => LOG_CSV_COLUMNS.map((column) => escapeCsvCell(event[column])).join(","))].join("\r\n");
}
function buildExportBundle(job, events, now) {
	return {
		exportedBy: EXTENSION_NAME,
		exportedAt: now,
		formatVersion: 1,
		selectorMapVersion: job.settings.selectorMapVersion,
		report: buildRunReport(job),
		run: job,
		events: [...events]
	};
}
function toJson(bundle) {
	return JSON.stringify(bundle, null, 2);
}
/**
* Reduces a segment to characters that are safe in a file name. Dots are dropped
* too, so a run id can never contribute a `..` sequence or a second extension.
*/
function safeSegment(value) {
	return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "") || "run";
}
function exportFileName(runId, extension, now) {
	const stamp = now.replace(/[:.]/g, "-");
	return `canva-team-exit-${safeSegment(runId)}-${safeSegment(stamp)}.${extension}`;
}
//#endregion
//#region src/popup/client.ts
async function send(command) {
	try {
		const response = await chrome.runtime.sendMessage(command);
		if (!response) return {
			ok: false,
			kind: "error",
			message: "The extension background worker did not answer.",
			category: "unknown",
			nextStep: "Close and reopen the popup. If it keeps happening, reload the extension."
		};
		return response;
	} catch (error) {
		return {
			ok: false,
			kind: "error",
			message: error instanceof Error ? error.message : String(error),
			category: "unknown",
			nextStep: "Reload the extension from chrome://extensions and try again."
		};
	}
}
async function fetchSnapshot() {
	const response = await send({ type: "GET_SNAPSHOT" });
	return response.ok && response.kind === "snapshot" ? response.snapshot : null;
}
async function fetchSettings() {
	const response = await send({ type: "GET_SETTINGS" });
	return response.ok && response.kind === "settings" ? response.settings : null;
}
async function fetchLogs(runId) {
	const response = await send(runId ? {
		type: "GET_LOGS",
		runId
	} : { type: "GET_LOGS" });
	return response.ok && response.kind === "logs" ? response.logs : [];
}
/**
* Subscribes to background broadcasts.
*
* The payload comes from this extension's own service worker, so it is shape-
* checked rather than fully re-validated; the background already validated
* everything that entered the state machine.
*/
function subscribe(handlers) {
	chrome.runtime.onMessage.addListener((raw, sender) => {
		if (sender.id !== chrome.runtime.id) return;
		if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
		const message = raw;
		if (message.type === "SNAPSHOT_UPDATED" && isSnapshotLike(message.snapshot)) {
			handlers.onSnapshot(message.snapshot);
			return;
		}
		if (message.type === "RUN_ATTENTION" && typeof message.message === "string") handlers.onAttention?.(message.message);
	});
}
function isSnapshotLike(value) {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value;
	return typeof candidate.job === "object" && candidate.job !== null && typeof candidate.settings === "object" && candidate.settings !== null && typeof candidate.page === "object" && candidate.page !== null;
}
//#endregion
//#region src/popup/dom.ts
/** Small DOM helpers shared by the popup and options pages. */
function byId(id) {
	const node = document.getElementById(id);
	if (!node) throw new Error(`Missing element #${id}`);
	return node;
}
function el(tag, options = {}, children = []) {
	const node = document.createElement(tag);
	if (options.className) node.className = options.className;
	if (options.text !== void 0) node.textContent = options.text;
	for (const [name, value] of Object.entries(options.attrs ?? {})) {
		if (value === null || value === false) continue;
		node.setAttribute(name, value === true ? "" : String(value));
	}
	for (const child of children) node.append(typeof child === "string" ? document.createTextNode(child) : child);
	return node;
}
function clear(node) {
	node.replaceChildren();
}
function setHidden(node, hidden) {
	node.hidden = hidden;
}
/** Fills a definition list, replacing whatever was there. */
function renderKeyValues(list, entries) {
	clear(list);
	for (const entry of entries) {
		list.append(el("dt", { text: entry.label }));
		list.append(el("dd", {
			text: entry.value,
			attrs: entry.tone && entry.tone !== "plain" ? { "data-tone": entry.tone } : {}
		}));
	}
}
function checkboxRow(options) {
	const input = el("input", { attrs: {
		type: "checkbox",
		id: options.id,
		...options.disabled ? { disabled: true } : {}
	} });
	input.checked = options.checked;
	input.addEventListener("change", () => options.onChange(input.checked));
	const text = el("span", {}, [options.label]);
	if (options.sublabel) text.append(el("span", {
		className: "sub",
		text: options.sublabel
	}));
	const label = el("label", { attrs: { for: options.id } });
	label.append(input, text);
	return label;
}
function button(options) {
	const node = el("button", {
		text: options.label,
		className: options.className ?? "btn",
		attrs: {
			type: "button",
			...options.disabled ? { disabled: true } : {},
			...options.title ? { title: options.title } : {}
		}
	});
	node.addEventListener("click", options.onClick);
	return node;
}
function flag(text, tone = "plain") {
	return el("span", {
		className: "flag",
		text,
		attrs: tone === "plain" ? {} : { "data-tone": tone }
	});
}
//#endregion
//#region src/popup/format.ts
var RUN_STATE_LABELS = {
	idle: "Not started",
	discoveringTeams: "Scanning teams",
	selectingTeams: "Choosing teams",
	discoveringItems: "Scanning designs",
	reviewReady: "Ready for review",
	awaitingStartConfirmation: "Waiting for confirmation",
	copying: "Copying",
	verifying: "Verifying",
	trashing: "Trashing originals",
	awaitingLeaveConfirmation: "Waiting to leave team",
	leavingTeam: "Leaving team",
	paused: "Paused",
	completed: "Completed",
	completedWithWarnings: "Completed with warnings",
	failed: "Failed",
	blocked: "Blocked"
};
var ITEM_STATE_LABELS = {
	discovered: "Found",
	selected: "Included",
	copyPending: "Queued to copy",
	copyInProgress: "Copying",
	copied: "Copied",
	copyFailed: "Copy failed",
	copyVerified: "Copy verified",
	deletePending: "Queued to trash",
	deleteInProgress: "Trashing",
	deleteFailed: "Trash failed",
	completed: "Done",
	skipped: "Skipped",
	manualReviewRequired: "Needs review"
};
function itemStateTone(state) {
	switch (state) {
		case "completed":
		case "copyVerified": return "ok";
		case "copyFailed":
		case "deleteFailed": return "error";
		case "manualReviewRequired":
		case "skipped": return "warn";
		default: return "plain";
	}
}
var VERIFICATION_LABELS = {
	unverified: "not verified",
	strong: "strong",
	weak: "weak",
	manual: "manual",
	failed: "failed"
};
var CAPABILITY_LABELS = {
	available: "copy available",
	unavailable: "no copy action",
	unknown: "not probed"
};
function capabilityTone(capability) {
	if (capability === "available") return "ok";
	if (capability === "unavailable") return "error";
	return "warn";
}
var RISK_FLAG_LABELS = {
	ownershipUnclear: "owner unclear",
	copyActionUnknown: "copy not probed",
	copyActionMissing: "no copy action",
	sharedWithTeam: "shared with team",
	itemTypeUnsupported: "type not supported",
	duplicateTitleInDestination: "duplicate title",
	titleEmpty: "no title"
};
var CONFIRMATION_LABELS = {
	liveExecution: {
		label: "I understand this run will change my Canva content",
		detail: "Copies will be made in the destination workspace."
	},
	trash: {
		label: "I approve moving verified originals to trash",
		detail: "Only items with a verified copy are trashed, and only to Canva trash."
	},
	leaveTeam: {
		label: "I approve leaving the selected teams",
		detail: "Each team also asks for a separate confirmation right before leaving."
	},
	multiTeamBatch: {
		label: "I approve processing more than one team in this batch",
		detail: "Teams are processed one at a time, in order."
	},
	largeBatch: {
		label: "I approve a large batch",
		detail: "This run is above the item threshold set in Options."
	}
};
function formatDuration(ms) {
	if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
	const totalSeconds = Math.round(ms / 1e3);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}
function formatTimestamp(value) {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
}
function truncate(value, max = 70) {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
//#endregion
export { send as C, toCsv as D, exportFileName as E, toJson as O, fetchSnapshot as S, buildExportBundle as T, flag as _, RUN_STATE_LABELS as a, fetchLogs as b, formatDuration as c, truncate as d, button as f, el as g, clear as h, RISK_FLAG_LABELS as i, downloadText as k, formatTimestamp as l, checkboxRow as m, CONFIRMATION_LABELS as n, VERIFICATION_LABELS as o, byId as p, ITEM_STATE_LABELS as r, capabilityTone as s, CAPABILITY_LABELS as t, itemStateTone as u, renderKeyValues as v, subscribe as w, fetchSettings as x, setHidden as y };

//# sourceMappingURL=format.js.map