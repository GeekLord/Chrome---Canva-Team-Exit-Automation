import { E as liveExecutionAllowed, M as EXECUTION_MODES, N as EXECUTION_MODE_DESCRIPTIONS, O as CANVA_ORIGIN, P as EXECUTION_MODE_LABELS, h as unresolvedItemsForTeam, k as CANVA_PROJECT_LIST_PATHS, n as buildRunReport, r as blockingItems, t as buildDryRunSummary } from "./assets/report.js";
import { n as isPreRun, r as isTerminal } from "./assets/run-state-machine.js";
import { C as send, D as toCsv, E as exportFileName, O as toJson, S as fetchSnapshot, T as buildExportBundle, _ as flag, a as RUN_STATE_LABELS, b as fetchLogs, c as formatDuration, d as truncate, f as button, g as el, h as clear, i as RISK_FLAG_LABELS, k as downloadText, l as formatTimestamp, m as checkboxRow, n as CONFIRMATION_LABELS, o as VERIFICATION_LABELS, p as byId, r as ITEM_STATE_LABELS, s as capabilityTone, t as CAPABILITY_LABELS, u as itemStateTone, v as renderKeyValues, w as subscribe, y as setHidden } from "./assets/format.js";
//#region src/popup/main.ts
/**
* Popup: the operations console.
*
* Reads a snapshot from the background engine and renders it. Every control maps
* to exactly one command; the popup holds no run state of its own, so closing it
* mid-run changes nothing.
*/
var MAX_ROWS = 150;
var snapshot = null;
var itemFilter = "all";
var busy = false;
function showAttention(message, tone = "warn") {
	const node = byId("attention");
	if (!message) {
		setHidden(node, true);
		node.textContent = "";
		return;
	}
	node.textContent = message;
	node.dataset.tone = tone;
	setHidden(node, false);
}
async function run(command) {
	if (busy) return;
	busy = true;
	setControlsBusy(true);
	try {
		const response = await send(command);
		if (!response.ok) {
			showAttention(response.nextStep ? `${response.message} ${response.nextStep}` : response.message, "error");
			const latest = await fetchSnapshot();
			if (latest) apply(latest);
			return;
		}
		showAttention(null);
		if (response.kind === "snapshot") apply(response.snapshot);
		else {
			const latest = await fetchSnapshot();
			if (latest) apply(latest);
		}
	} finally {
		busy = false;
		setControlsBusy(false);
	}
}
function setControlsBusy(value) {
	document.body.dataset.busy = String(value);
}
function apply(next) {
	snapshot = next;
	render(next);
}
function render(state) {
	renderHeader(state);
	renderPagePanel(state);
	renderDisclosure(state);
	renderSetup(state);
	renderReview(state);
	renderConfirmations(state);
	renderProgress(state);
	renderManualAssist(state);
	renderLeavePanel(state);
	renderIssues(state);
	renderReport(state);
	byId("selector-version").textContent = `selector map ${state.selectorMapVersion}`;
}
function renderHeader(state) {
	const { job } = state;
	const badge = byId("mode-badge");
	badge.textContent = job.mode === "dryRun" ? "Dry run" : `Live: ${EXECUTION_MODE_LABELS[job.mode]}`;
	badge.dataset.live = String(job.mode !== "dryRun");
	const parts = [RUN_STATE_LABELS[job.state]];
	if (job.destination) parts.push(`to ${job.destination.displayName}`);
	if (job.counters.itemsSelected > 0) parts.push(`${job.counters.itemsSelected} item(s) included`);
	byId("run-subtitle").textContent = parts.join(" · ");
}
function renderPagePanel(state) {
	const { page } = state;
	renderKeyValues(byId("page-details"), [
		{
			label: "Canva tab",
			value: page.detected ? "found" : "not open",
			tone: page.detected ? "ok" : "warn"
		},
		{
			label: "Signed in",
			value: page.loggedIn,
			tone: page.loggedIn === "yes" ? "ok" : page.loggedIn === "no" ? "error" : "warn"
		},
		{
			label: "Workspace",
			value: page.currentWorkspaceName ?? "unknown"
		},
		{
			label: "View",
			value: page.view
		},
		{
			label: "Interruption",
			value: page.interruption === "none" ? "none" : page.interruption,
			tone: page.interruption === "none" ? "ok" : "error"
		}
	]);
	const actions = byId("page-actions");
	clear(actions);
	actions.append(button({
		label: page.detected ? "Re-check tab" : "Open Canva",
		className: "btn btn--ghost btn--small",
		onClick: () => {
			if (page.detected) run({ type: "GET_SNAPSHOT" });
			else chrome.tabs.create({
				url: `${CANVA_ORIGIN}${CANVA_PROJECT_LIST_PATHS[0]}`,
				active: true
			}).then(() => run({ type: "GET_SNAPSHOT" }));
		}
	}));
}
function renderDisclosure(state) {
	const panel = byId("disclosure-panel");
	const accepted = state.settings.disclosureAcceptedAt !== null;
	setHidden(panel, accepted);
	if (accepted) return;
	const body = byId("disclosure-body");
	clear(body);
	body.append(el("p", { text: "This extension drives the Canva interface in your browser using your own session. In live modes it copies designs to the destination you pick, moves verified originals to Canva trash, and can leave a team on your behalf." }), el("p", { text: "Nothing is trashed before its copy is verified, and nothing leaves your machine: run state and logs stay in local extension storage." }), button({
		label: "I understand — continue in dry-run mode",
		onClick: () => void run({ type: "ACCEPT_DISCLOSURE" })
	}), el("p", {
		className: "hint",
		text: "Live execution stays off until you switch it on in Advanced settings."
	}));
}
function renderSetup(state) {
	const { job, discoveredTeams, settings } = state;
	const editable = isPreRun(job.state) || job.state === "paused";
	const scanTeams = byId("scan-teams");
	const scanItems = byId("scan-items");
	scanTeams.disabled = state.engineBusy || !editable;
	scanItems.disabled = state.engineBusy || !editable || job.sourceTeams.length === 0;
	const selectedIds = new Set(job.sourceTeams.map((team) => team.internalId));
	const list = byId("team-list");
	clear(list);
	if (discoveredTeams.length === 0) list.append(el("p", {
		className: "hint",
		text: "Scan teams to list the workspaces this session can switch into."
	}));
	for (const team of discoveredTeams) {
		const isDestination = job.destination?.teamId === team.internalId;
		list.append(checkboxRow({
			id: `team-${team.internalId}`,
			label: team.displayName,
			sublabel: [
				team.isCurrent ? "current workspace" : null,
				team.isPersonal ? "personal" : null,
				isDestination ? "selected as destination" : null,
				team.leaveSupportedState === "blockedByPolicy" ? "leaving is blocked" : null
			].filter((part) => part !== null).join(" · "),
			checked: selectedIds.has(team.internalId),
			disabled: !editable || isDestination,
			onChange: () => {
				run({
					type: "SELECT_TEAMS",
					teamIds: [...list.querySelectorAll("input[type=\"checkbox\"]")].filter((input) => input.checked).map((input) => input.id.replace(/^team-/, ""))
				});
			}
		}));
	}
	const destination = byId("destination-select");
	clear(destination);
	destination.disabled = !editable;
	destination.append(el("option", {
		text: "— no destination selected —",
		attrs: { value: "" }
	}));
	for (const team of discoveredTeams) {
		if (selectedIds.has(team.internalId)) continue;
		const option = el("option", {
			text: team.displayName,
			attrs: { value: team.internalId }
		});
		if (job.destination?.teamId === team.internalId) option.selected = true;
		destination.append(option);
	}
	const mode = byId("mode-select");
	clear(mode);
	mode.disabled = !isPreRun(job.state);
	const liveAllowed = liveExecutionAllowed(settings);
	for (const candidate of EXECUTION_MODES) {
		const option = el("option", {
			text: EXECUTION_MODE_LABELS[candidate],
			attrs: {
				value: candidate,
				...candidate !== "dryRun" && !liveAllowed ? { disabled: true } : {}
			}
		});
		if (job.mode === candidate) option.selected = true;
		mode.append(option);
	}
	byId("mode-hint").textContent = liveAllowed ? EXECUTION_MODE_DESCRIPTIONS[job.mode] : `${EXECUTION_MODE_DESCRIPTIONS[job.mode]} Live modes are disabled until you enable live execution in Advanced settings.`;
}
function renderReview(state) {
	const { job } = state;
	const panel = byId("review-panel");
	setHidden(panel, job.items.length === 0);
	if (job.items.length === 0) return;
	const summary = buildDryRunSummary(job);
	renderKeyValues(byId("dry-run-summary"), [
		{
			label: "Found",
			value: String(summary.totalFound)
		},
		{
			label: "Included",
			value: String(summary.selected)
		},
		{
			label: "Copy available",
			value: String(summary.copyable),
			tone: "ok"
		},
		{
			label: "No copy action",
			value: String(summary.blocked),
			tone: summary.blocked > 0 ? "error" : "plain"
		},
		{
			label: "Ambiguous",
			value: String(summary.ambiguous),
			tone: summary.ambiguous > 0 ? "warn" : "plain"
		}
	]);
	const filterSelect = byId("item-filter");
	filterSelect.value = itemFilter;
	const rows = byId("item-rows");
	clear(rows);
	const visible = job.items.filter((item) => matchesFilter(item, itemFilter));
	const shown = visible.slice(0, MAX_ROWS);
	const editable = !state.engineBusy && (isPreRun(job.state) || job.state === "paused" || isTerminal(job.state));
	for (const item of shown) rows.append(renderItemRow(state, item, editable));
	byId("item-table-note").textContent = visible.length > shown.length ? `Showing ${shown.length} of ${visible.length} matching items. Narrow the filter to see the rest.` : `${visible.length} matching item(s).`;
}
function matchesFilter(item, filter) {
	switch (filter) {
		case "included": return item.selected;
		case "excluded": return !item.selected;
		case "unresolved": return item.selected && (item.state === "copyFailed" || item.state === "deleteFailed" || item.state === "manualReviewRequired");
		default: return true;
	}
}
function renderItemRow(state, item, editable) {
	const row = el("tr");
	const includeCell = el("td");
	const includeBox = el("input", { attrs: {
		type: "checkbox",
		...editable ? {} : { disabled: true },
		"aria-label": `Include ${item.title}`
	} });
	includeBox.checked = item.selected;
	includeBox.addEventListener("change", () => {
		run({
			type: "SET_ITEM_INCLUSION",
			itemId: item.internalId,
			selected: includeBox.checked
		});
	});
	includeCell.append(includeBox);
	const titleCell = el("td", { className: "title" }, [truncate(item.title, 60)]);
	for (const riskFlag of item.riskFlags) titleCell.append(flag(RISK_FLAG_LABELS[riskFlag], riskFlag === "copyActionMissing" ? "error" : "warn"));
	const teamName = state.job.sourceTeams.find((team) => team.internalId === item.sourceTeamId)?.displayName ?? item.sourceTeamId;
	const ownerCell = el("td", {}, [item.ownerLabel ?? "—"]);
	ownerCell.append(flag(item.ownerConfidence, item.ownerConfidence === "high" ? "ok" : "warn"));
	const capabilityCell = el("td");
	capabilityCell.append(flag(CAPABILITY_LABELS[item.copyCapability], capabilityTone(item.copyCapability)));
	const statusCell = el("td");
	statusCell.append(flag(ITEM_STATE_LABELS[item.state], itemStateTone(item.state)));
	if (item.copyStatus === "copied") statusCell.append(flag(`verify: ${VERIFICATION_LABELS[item.verificationStatus]}`, verificationTone(item)));
	if (item.deleteStatus === "trashed") statusCell.append(flag("trashed", "ok"));
	const actionsCell = el("td");
	if (item.state === "copyFailed" || item.state === "deleteFailed" || item.state === "manualReviewRequired") actionsCell.append(button({
		label: "Retry",
		className: "btn btn--ghost btn--small",
		onClick: () => void run({
			type: "RETRY_ITEM",
			itemId: item.internalId
		})
	}), button({
		label: "Skip",
		className: "btn btn--ghost btn--small",
		onClick: () => void run({
			type: "SKIP_ITEM",
			itemId: item.internalId,
			reason: "Skipped from the review table"
		})
	}));
	else actionsCell.append(el("span", {
		className: "hint",
		text: "—"
	}));
	row.append(includeCell, titleCell, el("td", {}, [truncate(teamName, 24)]), ownerCell, capabilityCell, statusCell, actionsCell);
	return row;
}
function verificationTone(item) {
	switch (item.verificationStatus) {
		case "strong": return "ok";
		case "weak":
		case "manual": return "warn";
		case "failed": return "error";
		default: return "plain";
	}
}
function renderConfirmations(state) {
	const { job } = state;
	const panel = byId("confirm-panel");
	setHidden(panel, job.items.length === 0);
	if (job.items.length === 0) return;
	const granted = new Set(job.confirmations.scopes);
	const list = byId("confirmations");
	clear(list);
	if (state.requiredConfirmations.length === 0) list.append(el("p", {
		className: "hint",
		text: "A dry run needs no confirmations. Nothing in Canva changes."
	}));
	for (const scope of state.requiredConfirmations) {
		const copy = CONFIRMATION_LABELS[scope];
		list.append(checkboxRow({
			id: `confirm-${scope}`,
			label: copy.label,
			sublabel: copy.detail,
			checked: granted.has(scope),
			disabled: state.engineBusy,
			onChange: (checked) => void run(checked ? {
				type: "GRANT_CONFIRMATION",
				scope
			} : {
				type: "REVOKE_CONFIRMATION",
				scope
			})
		}));
	}
	byId("start-guard").textContent = state.startGuard.allowed ? "All pre-run checks pass." : state.startGuard.reason ?? "";
	const controls = byId("run-controls");
	clear(controls);
	if (job.mode === "dryRun") controls.append(button({
		label: "Finish dry run and save report",
		disabled: state.engineBusy || isTerminal(job.state) || job.items.length === 0,
		onClick: () => void run({ type: "STOP_RUN" })
	}));
	else if (isTerminal(job.state)) controls.append(el("p", {
		className: "hint",
		text: "This run has finished. Start a new run to go again."
	}));
	else if (job.state === "paused" || job.state === "blocked") controls.append(button({
		label: "Resume",
		disabled: state.engineBusy || job.manualAssist !== null,
		onClick: () => void run({ type: "RESUME_RUN" })
	}), button({
		label: "Stop run",
		className: "btn btn--danger",
		onClick: () => void run({ type: "STOP_RUN" })
	}));
	else if (job.startedAt === null) controls.append(button({
		label: `Start ${EXECUTION_MODE_LABELS[job.mode].toLowerCase()}`,
		disabled: !state.startGuard.allowed || state.engineBusy,
		title: state.startGuard.reason ?? void 0,
		onClick: () => void run({ type: "START_RUN" })
	}));
	else controls.append(button({
		label: "Pause",
		onClick: () => void run({ type: "PAUSE_RUN" })
	}), button({
		label: "Stop run",
		className: "btn btn--danger",
		onClick: () => void run({ type: "STOP_RUN" })
	}));
}
function renderProgress(state) {
	const { job } = state;
	const panel = byId("progress-panel");
	const active = job.startedAt !== null || job.state === "discoveringItems" || job.state === "discoveringTeams";
	setHidden(panel, !active);
	if (!active) return;
	byId("current-action").textContent = job.currentAction ?? state.plan.description ?? (job.state === "paused" ? job.pauseReason ?? "Paused" : "—");
	const total = Math.max(1, job.counters.itemsSelected);
	const done = job.counters.trashed + job.counters.skipped + job.counters.copied;
	const progress = byId("run-progress");
	progress.value = Math.min(100, Math.round(done / total * 100));
	renderKeyValues(byId("counters"), [
		{
			label: "Copied",
			value: `${job.counters.copied}/${job.counters.itemsSelected}`,
			tone: "ok"
		},
		{
			label: "Verified",
			value: String(job.counters.verified),
			tone: "ok"
		},
		{
			label: "Trashed",
			value: String(job.counters.trashed)
		},
		{
			label: "Remaining",
			value: String(state.plan.remainingItems)
		},
		{
			label: "Failed",
			value: String(job.counters.failed),
			tone: job.counters.failed > 0 ? "error" : "plain"
		},
		{
			label: "Skipped",
			value: String(job.counters.skipped),
			tone: job.counters.skipped > 0 ? "warn" : "plain"
		},
		{
			label: "Needs review",
			value: String(job.counters.manualReview),
			tone: job.counters.manualReview > 0 ? "warn" : "plain"
		},
		{
			label: "Teams left",
			value: `${job.counters.teamsLeft}/${job.counters.teamsSelected}`
		}
	]);
}
function renderManualAssist(state) {
	const { job } = state;
	const panel = byId("assist-panel");
	setHidden(panel, job.manualAssist === null);
	if (!job.manualAssist) return;
	const item = job.items.find((candidate) => candidate.internalId === job.manualAssist?.itemId);
	byId("assist-instruction").textContent = `${job.manualAssist.instruction}${item ? ` (${ITEM_STATE_LABELS[item.state]})` : ""}`;
	const actions = byId("assist-actions");
	clear(actions);
	actions.append(button({
		label: "I did it — continue",
		onClick: () => void run({
			type: "RESOLVE_MANUAL_ASSIST",
			itemId: job.manualAssist?.itemId ?? "",
			outcome: "done"
		})
	}), button({
		label: "Skip this item",
		className: "btn btn--ghost",
		onClick: () => void run({
			type: "RESOLVE_MANUAL_ASSIST",
			itemId: job.manualAssist?.itemId ?? "",
			outcome: "skip"
		})
	}));
}
function renderLeavePanel(state) {
	const { job } = state;
	const teamId = job.activeTeamId;
	const show = job.state === "awaitingLeaveConfirmation" && teamId !== null;
	const panel = byId("leave-panel");
	setHidden(panel, !show);
	if (!show || !teamId) return;
	const team = job.sourceTeams.find((candidate) => candidate.internalId === teamId);
	const unresolved = unresolvedItemsForTeam(job, teamId);
	const body = byId("leave-body");
	clear(body);
	body.append(el("p", { text: `Ready to leave "${team?.displayName ?? teamId}". You lose access to everything still in that team.` }));
	const checklist = el("ul", { className: "issues" });
	checklist.append(el("li", { text: `${job.counters.copied} copied, ${job.counters.verified} verified, ${job.counters.trashed} original(s) trashed.` }));
	if (unresolved.length > 0) checklist.append(el("li", { text: `${unresolved.length} selected item(s) are unresolved: ${unresolved.slice(0, 4).map((item) => truncate(item.title, 24)).join(", ")}${unresolved.length > 4 ? "…" : ""}` }));
	if (team?.leaveSupportedState === "blockedByPolicy") checklist.append(el("li", { text: "Canva reported that leaving this team is blocked for you." }));
	body.append(checklist);
	const blocked = unresolved.length > 0 && !job.userOverrides.allowLeaveWithUnresolvedItems;
	body.append(el("div", { className: "row" }, [button({
		label: "Confirm and leave this team",
		className: "btn btn--danger",
		disabled: blocked || state.engineBusy,
		title: blocked ? "Resolve or skip the remaining items first." : void 0,
		onClick: () => void run({
			type: "CONFIRM_LEAVE",
			teamId
		})
	}), button({
		label: "Do not leave — finish this team",
		className: "btn btn--ghost",
		onClick: () => void run({
			type: "SKIP_LEAVE",
			teamId
		})
	})]));
	if (blocked) body.append(el("p", {
		className: "hint",
		text: "Leaving stays blocked while selected items are unresolved. Retry or skip them in the review table, or set the advanced override in settings."
	}));
}
function renderIssues(state) {
	const { job } = state;
	const problems = blockingItems(job);
	const panel = byId("issues-panel");
	const show = problems.length > 0 || job.blocker !== null;
	setHidden(panel, !show);
	if (!show) return;
	const list = byId("issue-list");
	clear(list);
	if (job.blocker) list.append(el("li", {}, [
		el("strong", { text: `${job.blocker.message} ` }),
		el("span", { text: job.blocker.explanation }),
		el("span", {
			className: "next-step",
			text: `Next: ${job.blocker.nextStep}`
		})
	]));
	for (const item of problems.slice(0, 12)) {
		const entry = el("li", {}, [el("strong", { text: `${truncate(item.title, 40)} — ${ITEM_STATE_LABELS[item.state]}. ` }), el("span", { text: item.lastError?.explanation ?? "Unresolved." })]);
		if (item.lastError?.nextStep) entry.append(el("span", {
			className: "next-step",
			text: `Next: ${item.lastError.nextStep}`
		}));
		list.append(entry);
	}
}
function renderReport(state) {
	const { job } = state;
	const panel = byId("report-panel");
	setHidden(panel, !isTerminal(job.state));
	if (!isTerminal(job.state)) return;
	const report = buildRunReport(job);
	renderKeyValues(byId("report-counters"), [
		{
			label: "Outcome",
			value: RUN_STATE_LABELS[report.state],
			tone: report.state === "completed" ? "ok" : "warn"
		},
		{
			label: "Mode",
			value: EXECUTION_MODE_LABELS[report.mode]
		},
		{
			label: "Duration",
			value: formatDuration(report.durationMs)
		},
		{
			label: "Finished",
			value: formatTimestamp(report.endedAt)
		},
		{
			label: "Teams processed",
			value: `${report.teamsProcessed}/${report.teamsSelected}`
		},
		{
			label: "Teams left",
			value: String(report.teamsLeft)
		},
		{
			label: "Items found",
			value: String(report.itemsFound)
		},
		{
			label: "Items included",
			value: String(report.itemsSelected)
		},
		{
			label: "Copied",
			value: String(report.copied),
			tone: "ok"
		},
		{
			label: "Verified",
			value: String(report.verified),
			tone: "ok"
		},
		{
			label: "Trashed",
			value: String(report.trashed)
		},
		{
			label: "Failed",
			value: String(report.failed),
			tone: report.failed > 0 ? "error" : "plain"
		},
		{
			label: "Skipped",
			value: String(report.skipped),
			tone: report.skipped > 0 ? "warn" : "plain"
		},
		{
			label: "Blocking issues",
			value: String(report.blockingIssues.length),
			tone: report.blockingIssues.length > 0 ? "error" : "ok"
		}
	]);
	const teams = byId("report-teams");
	clear(teams);
	const wrapper = el("div", { className: "team-report" });
	for (const team of report.teams) wrapper.append(el("div", { text: `${team.displayName}: ${team.copied} copied, ${team.verified} verified, ${team.trashed} trashed, ${team.unresolved} unresolved${team.left ? ", team left" : team.leaveState === "blockedByPolicy" ? ", leaving blocked" : ""}` }));
	teams.append(wrapper);
}
async function exportRun(format) {
	const state = snapshot;
	if (!state) return;
	const events = await fetchLogs(state.job.runId);
	const now = (/* @__PURE__ */ new Date()).toISOString();
	if (format === "json") {
		const bundle = buildExportBundle(state.job, events, now);
		downloadText(exportFileName(state.job.runId, "json", now), "application/json", toJson(bundle));
	} else downloadText(exportFileName(state.job.runId, "csv", now), "text/csv", toCsv(events));
}
function wireEvents() {
	byId("scan-teams").addEventListener("click", () => void run({ type: "SCAN_TEAMS" }));
	byId("scan-items").addEventListener("click", () => void run({ type: "SCAN_ITEMS" }));
	byId("destination-select").addEventListener("change", (event) => {
		const value = event.target.value;
		run({
			type: "SELECT_DESTINATION",
			teamId: value === "" ? null : value
		});
	});
	byId("mode-select").addEventListener("change", (event) => {
		run({
			type: "SELECT_MODE",
			mode: event.target.value
		});
	});
	byId("item-filter").addEventListener("change", (event) => {
		itemFilter = event.target.value;
		if (snapshot) render(snapshot);
	});
	byId("include-all").addEventListener("click", () => void run({
		type: "SET_ALL_INCLUSIONS",
		selected: true,
		teamId: null
	}));
	byId("exclude-all").addEventListener("click", () => void run({
		type: "SET_ALL_INCLUSIONS",
		selected: false,
		teamId: null
	}));
	byId("export-json").addEventListener("click", () => void exportRun("json"));
	byId("export-csv").addEventListener("click", () => void exportRun("csv"));
	byId("new-run").addEventListener("click", () => void run({ type: "NEW_RUN" }));
	byId("open-options").addEventListener("click", () => {
		chrome.runtime.openOptionsPage();
	});
}
async function start() {
	wireEvents();
	subscribe({
		onSnapshot: (next) => {
			if (!busy) apply(next);
		},
		onAttention: (message) => showAttention(message, "error")
	});
	const initial = await fetchSnapshot();
	if (initial) apply(initial);
	else showAttention("Could not reach the extension background worker.", "error");
}
start();
//#endregion

//# sourceMappingURL=popup.js.map