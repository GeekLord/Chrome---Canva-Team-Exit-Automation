import { E as liveExecutionAllowed, M as EXECUTION_MODES, P as EXECUTION_MODE_LABELS } from "./assets/report.js";
import { C as send, D as toCsv, E as exportFileName, O as toJson, S as fetchSnapshot, T as buildExportBundle, b as fetchLogs, f as button, g as el, h as clear, k as downloadText, l as formatTimestamp, p as byId, x as fetchSettings } from "./assets/format.js";
//#region src/content/selector-map.ts
/**
* The single versioned selector map.
*
* Every DOM selector and UI heuristic in this extension lives here. Business
* logic and action executors reference specs by key and never contain a raw
* selector, so a Canva redesign is a change to this one file.
*
* Strategy order inside each spec matters: earlier candidates are preferred.
* Role, `aria-*` and stable visible text come first because they survive Canva's
* CSS churn; hashed class names are a last resort and are deliberately absent.
*
* Text candidates are English-first. Canva localises its interface, so a user on
* a non-English locale should expect `selector_not_found` and fall back to
* manual assist. That trade-off is documented in the README.
*/
var SELECTOR_MAP_VERSION = "2026-08-04.1";
/** Documented assumptions, surfaced in the Options diagnostics panel. */
var SELECTOR_MAP_NOTES = [
	"Canva does not publish a stable DOM contract. Every candidate here is a heuristic that may need updating.",
	"Role and aria-label candidates are tried before visible text; hashed CSS class names are never used.",
	"Visible-text candidates assume the Canva interface is in English.",
	"Copy is performed through Canva's own \"copy to another team\" flow, one item at a time.",
	"Trash means Canva's move-to-trash action. Permanent deletion is not automated.",
	"Leaving a team uses the visible control in Canva settings and can be blocked by team admins."
];
//#endregion
//#region src/options/main.ts
/**
* Options page: pacing, discovery limits, the advanced overrides, diagnostics
* and local-data controls.
*
* Fields are generated from a declarative spec so labels, hints and validation
* bounds stay next to each other. UI helpers are shared with the popup.
*/
var settings = null;
var PACING_FIELDS = [
	{
		kind: "number",
		key: "actionDelayMs",
		label: "Base delay between actions (ms)",
		hint: `Never goes below 400 ms, whatever is stored.`,
		min: 400,
		max: 3e4,
		step: 100
	},
	{
		kind: "number",
		key: "actionJitterMs",
		label: "Random jitter added to each delay (ms)",
		hint: "Keeps the pattern from looking metronomic.",
		min: 0,
		max: 3e4,
		step: 100
	},
	{
		kind: "number",
		key: "actionTimeoutMs",
		label: "Timeout for a single action (ms)",
		hint: "How long one copy, verify or trash step may take before it fails.",
		min: 2e3,
		max: 12e4,
		step: 500
	},
	{
		kind: "number",
		key: "discoveryTimeoutMs",
		label: "Timeout for scanning one team (ms)",
		hint: "Large teams with lazy-loading lists need more.",
		min: 5e3,
		max: 6e5,
		step: 1e3
	},
	{
		kind: "number",
		key: "maxRetriesPerAction",
		label: "Retries per action",
		hint: "Applies only to failures that are worth repeating.",
		min: 0,
		max: 10
	},
	{
		kind: "number",
		key: "backoffMultiplier",
		label: "Retry backoff multiplier",
		hint: "Each retry waits this many times longer than the last.",
		min: 1,
		max: 10,
		step: .5
	},
	{
		kind: "number",
		key: "circuitBreakerThreshold",
		label: "Failures in a row before pausing",
		hint: "Stops a broken selector from turning into a burst of pointless clicking.",
		min: 1,
		max: 100
	}
];
var DISCOVERY_FIELDS = [
	{
		kind: "toggle",
		key: "requireOwnedByMe",
		label: "Only pre-select designs Canva says you own",
		hint: "Items with no clear owner label are still listed, but start unchecked."
	},
	{
		kind: "number",
		key: "probeItemLimitPerTeam",
		label: "Capability probes per team",
		hint: "Each probe opens one item menu, so this is capped. Items past the cap show as \"not probed\".",
		min: 0,
		max: 500
	},
	{
		kind: "number",
		key: "confirmationItemThreshold",
		label: "Extra confirmation above this many items",
		hint: "Runs larger than this need a separate large-batch confirmation.",
		min: 1,
		max: 1e4
	},
	{
		kind: "toggle",
		key: "pauseBetweenTeams",
		label: "Pause between teams",
		hint: "Recommended: gives you a checkpoint before each new team."
	},
	{
		kind: "toggle",
		key: "manualAssistEnabled",
		label: "Offer a manual step when automation stalls",
		hint: "Highlights the item in Canva and waits for you instead of failing the item outright."
	}
];
var OVERRIDE_FIELDS = [{
	kind: "override",
	key: "allowTrashWithoutVerification",
	label: "Allow trashing originals whose copy could not be verified",
	hint: "Removes the main protection against losing work. Off by default for good reason."
}, {
	kind: "override",
	key: "allowLeaveWithUnresolvedItems",
	label: "Allow leaving a team while items are unresolved",
	hint: "You lose access to anything still in that team, including items that failed to copy."
}];
var DIAGNOSTIC_FIELDS = [{
	kind: "toggle",
	key: "debugMode",
	label: "Debug mode",
	hint: "Adds verbose selector and step traces to the run log and the worker console."
}];
var DATA_FIELDS = [{
	kind: "number",
	key: "logRetentionMaxEvents",
	label: "Log events kept per run",
	hint: "Older events are dropped once a run passes this many.",
	min: 100,
	max: 2e4,
	step: 100
}];
function announce(message) {
	byId("save-status").textContent = message;
}
async function patch(update) {
	const response = await send({
		type: "UPDATE_SETTINGS",
		patch: update
	});
	if (response.ok && response.kind === "settings") {
		settings = response.settings;
		announce(`Saved at ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}.`);
		renderAll();
	} else if (!response.ok) announce(`Could not save: ${response.message}`);
}
function numberField(spec, current) {
	const id = `field-${spec.key}`;
	const input = el("input", { attrs: {
		type: "number",
		id,
		min: spec.min,
		max: spec.max,
		...spec.step ? { step: spec.step } : {},
		"aria-describedby": `${id}-hint`
	} });
	input.value = String(current[spec.key]);
	input.addEventListener("change", () => {
		const parsed = Number(input.value);
		if (!Number.isFinite(parsed)) {
			input.value = String(current[spec.key]);
			return;
		}
		patch({ [spec.key]: parsed });
	});
	const wrapper = el("div", { className: "field" });
	wrapper.append(el("label", {
		text: spec.label,
		attrs: { for: id }
	}), input, el("p", {
		className: "hint",
		text: spec.hint,
		attrs: { id: `${id}-hint` }
	}));
	return wrapper;
}
function toggleField(id, label, hint, checked, onChange) {
	const input = el("input", { attrs: {
		type: "checkbox",
		id,
		"aria-describedby": `${id}-hint`
	} });
	input.checked = checked;
	input.addEventListener("change", () => onChange(input.checked));
	const wrapper = el("div", { className: "field field--toggle" });
	wrapper.append(input, el("label", {
		text: label,
		attrs: { for: id }
	}), el("p", {
		className: "hint",
		text: hint,
		attrs: { id: `${id}-hint` }
	}));
	return wrapper;
}
function renderFields(containerId, specs, current) {
	const container = byId(containerId);
	clear(container);
	for (const spec of specs) {
		if (spec.kind === "number") {
			container.append(numberField(spec, current));
			continue;
		}
		if (spec.kind === "toggle") {
			container.append(toggleField(`field-${spec.key}`, spec.label, spec.hint, current[spec.key], (value) => void patch({ [spec.key]: value })));
			continue;
		}
		container.append(toggleField(`field-override-${spec.key}`, spec.label, spec.hint, current.overrides[spec.key], (value) => void patch({ overrides: {
			...current.overrides,
			[spec.key]: value
		} })));
	}
}
function renderExecution(current) {
	const container = byId("execution-fields");
	clear(container);
	const accepted = current.disclosureAcceptedAt !== null;
	container.append(el("div", { className: "field field--toggle" }, [
		el("span", { text: accepted ? "✓" : "•" }),
		el("label", { text: accepted ? `Disclosure accepted ${formatTimestamp(current.disclosureAcceptedAt)}` : "Disclosure not accepted yet" }),
		el("p", {
			className: "hint",
			text: accepted ? "You can still keep live execution off; dry runs never change anything." : "Accept the disclosure in the popup before enabling live execution."
		})
	]));
	container.append(toggleField("field-liveExecutionEnabled", "Enable live execution for this browser profile", "Required before any mode other than dry run can be selected or started.", current.liveExecutionEnabled, (value) => {
		if (value && current.disclosureAcceptedAt === null) {
			announce("Accept the disclosure in the popup first.");
			renderAll();
			return;
		}
		patch({ liveExecutionEnabled: value });
	}));
	const modeId = "field-defaultMode";
	const select = el("select", { attrs: {
		id: modeId,
		"aria-describedby": `${modeId}-hint`
	} });
	for (const mode of EXECUTION_MODES) {
		const option = el("option", {
			text: EXECUTION_MODE_LABELS[mode],
			attrs: {
				value: mode,
				...mode !== "dryRun" && !liveExecutionAllowed(current) ? { disabled: true } : {}
			}
		});
		if (current.defaultMode === mode) option.selected = true;
		select.append(option);
	}
	select.addEventListener("change", () => {
		patch({ defaultMode: select.value });
	});
	const modeWrapper = el("div", { className: "field" });
	modeWrapper.append(el("label", {
		text: "Mode for new runs",
		attrs: { for: modeId }
	}), select, el("p", {
		className: "hint",
		text: "New runs start in this mode. Dry run is the safe default.",
		attrs: { id: `${modeId}-hint` }
	}));
	container.append(modeWrapper);
}
function renderDiagnostics(current) {
	renderFields("diagnostics-fields", DIAGNOSTIC_FIELDS, current);
	byId("selector-version").textContent = `Version ${SELECTOR_MAP_VERSION}. Every selector the extension uses lives in one versioned map.`;
	const notes = byId("selector-notes");
	clear(notes);
	for (const note of SELECTOR_MAP_NOTES) notes.append(el("li", { text: note }));
}
function renderDataActions() {
	const actions = byId("data-actions");
	clear(actions);
	actions.append(button({
		label: "Export current run (JSON)",
		className: "btn btn--ghost",
		onClick: () => void exportRun("json")
	}), button({
		label: "Export current run (CSV)",
		className: "btn btn--ghost",
		onClick: () => void exportRun("csv")
	}), button({
		label: "Restore default settings",
		className: "btn btn--ghost",
		onClick: () => {
			(async () => {
				const response = await send({ type: "RESET_SETTINGS" });
				if (response.ok && response.kind === "settings") {
					settings = response.settings;
					announce("Settings restored to defaults.");
					renderAll();
				}
			})();
		}
	}), button({
		label: "Purge all local data",
		className: "btn btn--danger",
		onClick: () => {
			if (!window.confirm("Delete all local extension data? This removes settings, the current run state and every stored run log. Your Canva content is not touched.")) return;
			(async () => {
				const response = await send({ type: "PURGE_LOCAL_DATA" });
				if (response.ok) {
					announce("Local data purged.");
					await load();
				} else announce(`Could not purge: ${response.message}`);
			})();
		}
	}));
}
async function renderDataSummary() {
	const snapshot = await fetchSnapshot();
	if (!snapshot) {
		byId("data-summary").textContent = "No run data stored yet.";
		return;
	}
	const logs = await fetchLogs(snapshot.job.runId);
	byId("data-summary").textContent = `Current run ${snapshot.job.runId}: ${snapshot.job.items.length} item(s), ${logs.length} log event(s) stored.`;
}
function renderAll() {
	const current = settings;
	if (!current) return;
	renderExecution(current);
	renderFields("pacing-fields", PACING_FIELDS, current);
	renderFields("discovery-fields", DISCOVERY_FIELDS, current);
	renderFields("override-fields", OVERRIDE_FIELDS, current);
	renderDiagnostics(current);
	renderFields("data-fields", DATA_FIELDS, current);
	renderDataActions();
}
async function exportRun(format) {
	const snapshot = await fetchSnapshot();
	if (!snapshot) {
		announce("There is no run to export yet.");
		return;
	}
	const events = await fetchLogs(snapshot.job.runId);
	const now = (/* @__PURE__ */ new Date()).toISOString();
	if (format === "json") {
		const bundle = buildExportBundle(snapshot.job, events, now);
		downloadText(exportFileName(snapshot.job.runId, "json", now), "application/json", toJson(bundle));
	} else downloadText(exportFileName(snapshot.job.runId, "csv", now), "text/csv", toCsv(events));
	announce(`Exported ${events.length} log event(s).`);
}
async function load() {
	settings = await fetchSettings();
	if (!settings) {
		announce("Could not reach the extension background worker.");
		return;
	}
	renderAll();
	await renderDataSummary();
}
load();
//#endregion

//# sourceMappingURL=options.js.map