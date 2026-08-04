/**
 * Options page: pacing, discovery limits, the advanced overrides, diagnostics
 * and local-data controls.
 *
 * Fields are generated from a declarative spec so labels, hints and validation
 * bounds stay next to each other. UI helpers are shared with the popup.
 */

import { downloadText } from '../logging/download';
import { buildExportBundle, exportFileName, toCsv, toJson } from '../logging/exporters';
import { EXECUTION_MODE_LABELS, EXECUTION_MODES, MIN_ACTION_DELAY_MS } from '../shared/constants';
import { SELECTOR_MAP_NOTES, SELECTOR_MAP_VERSION } from '../content/selector-map';
import { liveExecutionAllowed } from '../shared/settings';
import type { ExecutionMode, Settings, UserOverrides } from '../shared/types';
import { fetchLogs, fetchSnapshot, fetchSettings, send } from '../popup/client';
import { button, byId, clear, el } from '../popup/dom';
import { formatTimestamp } from '../popup/format';

type NumericKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

type BooleanKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

interface NumberFieldSpec {
  kind: 'number';
  key: NumericKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step?: number;
}

interface ToggleFieldSpec {
  kind: 'toggle';
  key: BooleanKey;
  label: string;
  hint: string;
}

interface OverrideFieldSpec {
  kind: 'override';
  key: keyof UserOverrides;
  label: string;
  hint: string;
}

type FieldSpec = NumberFieldSpec | ToggleFieldSpec | OverrideFieldSpec;

let settings: Settings | null = null;

const PACING_FIELDS: FieldSpec[] = [
  {
    kind: 'number',
    key: 'actionDelayMs',
    label: 'Base delay between actions (ms)',
    hint: `Never goes below ${MIN_ACTION_DELAY_MS} ms, whatever is stored.`,
    min: MIN_ACTION_DELAY_MS,
    max: 30000,
    step: 100,
  },
  {
    kind: 'number',
    key: 'actionJitterMs',
    label: 'Random jitter added to each delay (ms)',
    hint: 'Keeps the pattern from looking metronomic.',
    min: 0,
    max: 30000,
    step: 100,
  },
  {
    kind: 'number',
    key: 'actionTimeoutMs',
    label: 'Timeout for a single action (ms)',
    hint: 'How long one copy, verify or trash step may take before it fails.',
    min: 2000,
    max: 120000,
    step: 500,
  },
  {
    kind: 'number',
    key: 'discoveryTimeoutMs',
    label: 'Timeout for scanning one team (ms)',
    hint: 'Large teams with lazy-loading lists need more.',
    min: 5000,
    max: 600000,
    step: 1000,
  },
  {
    kind: 'number',
    key: 'maxRetriesPerAction',
    label: 'Retries per action',
    hint: 'Applies only to failures that are worth repeating.',
    min: 0,
    max: 10,
  },
  {
    kind: 'number',
    key: 'backoffMultiplier',
    label: 'Retry backoff multiplier',
    hint: 'Each retry waits this many times longer than the last.',
    min: 1,
    max: 10,
    step: 0.5,
  },
  {
    kind: 'number',
    key: 'circuitBreakerThreshold',
    label: 'Failures in a row before pausing',
    hint: 'Stops a broken selector from turning into a burst of pointless clicking.',
    min: 1,
    max: 100,
  },
];

const DISCOVERY_FIELDS: FieldSpec[] = [
  {
    kind: 'toggle',
    key: 'requireOwnedByMe',
    label: 'Only pre-select designs Canva says you own',
    hint: 'Items with no clear owner label are still listed, but start unchecked.',
  },
  {
    kind: 'number',
    key: 'probeItemLimitPerTeam',
    label: 'Capability probes per team',
    hint: 'Each probe opens one item menu, so this is capped. Items past the cap show as "not probed".',
    min: 0,
    max: 500,
  },
  {
    kind: 'number',
    key: 'confirmationItemThreshold',
    label: 'Extra confirmation above this many items',
    hint: 'Runs larger than this need a separate large-batch confirmation.',
    min: 1,
    max: 10000,
  },
  {
    kind: 'toggle',
    key: 'pauseBetweenTeams',
    label: 'Pause between teams',
    hint: 'Recommended: gives you a checkpoint before each new team.',
  },
  {
    kind: 'toggle',
    key: 'manualAssistEnabled',
    label: 'Offer a manual step when automation stalls',
    hint: 'Highlights the item in Canva and waits for you instead of failing the item outright.',
  },
];

const OVERRIDE_FIELDS: FieldSpec[] = [
  {
    kind: 'override',
    key: 'allowTrashWithoutVerification',
    label: 'Allow trashing originals whose copy could not be verified',
    hint: 'Removes the main protection against losing work. Off by default for good reason.',
  },
  {
    kind: 'override',
    key: 'allowLeaveWithUnresolvedItems',
    label: 'Allow leaving a team while items are unresolved',
    hint: 'You lose access to anything still in that team, including items that failed to copy.',
  },
];

const DIAGNOSTIC_FIELDS: FieldSpec[] = [
  {
    kind: 'toggle',
    key: 'debugMode',
    label: 'Debug mode',
    hint: 'Adds verbose selector and step traces to the run log and the worker console.',
  },
];

const DATA_FIELDS: FieldSpec[] = [
  {
    kind: 'number',
    key: 'logRetentionMaxEvents',
    label: 'Log events kept per run',
    hint: 'Older events are dropped once a run passes this many.',
    min: 100,
    max: 20000,
    step: 100,
  },
];

/* ------------------------------------------------------------------ rendering --- */

function announce(message: string): void {
  byId('save-status').textContent = message;
}

async function patch(update: Partial<Settings>): Promise<void> {
  const response = await send({ type: 'UPDATE_SETTINGS', patch: update });
  if (response.ok && response.kind === 'settings') {
    settings = response.settings;
    announce(`Saved at ${new Date().toLocaleTimeString()}.`);
    renderAll();
  } else if (!response.ok) {
    announce(`Could not save: ${response.message}`);
  }
}

function numberField(spec: NumberFieldSpec, current: Settings): HTMLElement {
  const id = `field-${spec.key}`;
  const input = el('input', {
    attrs: {
      type: 'number',
      id,
      min: spec.min,
      max: spec.max,
      ...(spec.step ? { step: spec.step } : {}),
      'aria-describedby': `${id}-hint`,
    },
  });
  input.value = String(current[spec.key]);
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) {
      input.value = String(current[spec.key]);
      return;
    }
    void patch({ [spec.key]: parsed } as Partial<Settings>);
  });

  const wrapper = el('div', { className: 'field' });
  wrapper.append(
    el('label', { text: spec.label, attrs: { for: id } }),
    input,
    el('p', { className: 'hint', text: spec.hint, attrs: { id: `${id}-hint` } }),
  );
  return wrapper;
}

function toggleField(
  id: string,
  label: string,
  hint: string,
  checked: boolean,
  onChange: (value: boolean) => void,
): HTMLElement {
  const input = el('input', { attrs: { type: 'checkbox', id, 'aria-describedby': `${id}-hint` } });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));

  const wrapper = el('div', { className: 'field field--toggle' });
  wrapper.append(
    input,
    el('label', { text: label, attrs: { for: id } }),
    el('p', { className: 'hint', text: hint, attrs: { id: `${id}-hint` } }),
  );
  return wrapper;
}

function renderFields(containerId: string, specs: readonly FieldSpec[], current: Settings): void {
  const container = byId(containerId);
  clear(container);

  for (const spec of specs) {
    if (spec.kind === 'number') {
      container.append(numberField(spec, current));
      continue;
    }
    if (spec.kind === 'toggle') {
      container.append(
        toggleField(`field-${spec.key}`, spec.label, spec.hint, current[spec.key], (value) =>
          void patch({ [spec.key]: value } as Partial<Settings>),
        ),
      );
      continue;
    }
    container.append(
      toggleField(
        `field-override-${spec.key}`,
        spec.label,
        spec.hint,
        current.overrides[spec.key],
        (value) => void patch({ overrides: { ...current.overrides, [spec.key]: value } }),
      ),
    );
  }
}

function renderExecution(current: Settings): void {
  const container = byId('execution-fields');
  clear(container);

  const accepted = current.disclosureAcceptedAt !== null;
  container.append(
    el('div', { className: 'field field--toggle' }, [
      el('span', { text: accepted ? '\u2713' : '\u2022' }),
      el('label', {
        text: accepted ? `Disclosure accepted ${formatTimestamp(current.disclosureAcceptedAt)}` : 'Disclosure not accepted yet',
      }),
      el('p', {
        className: 'hint',
        text: accepted
          ? 'You can still keep live execution off; dry runs never change anything.'
          : 'Accept the disclosure in the popup before enabling live execution.',
      }),
    ]),
  );

  container.append(
    toggleField(
      'field-liveExecutionEnabled',
      'Enable live execution for this browser profile',
      'Required before any mode other than dry run can be selected or started.',
      current.liveExecutionEnabled,
      (value) => {
        if (value && current.disclosureAcceptedAt === null) {
          announce('Accept the disclosure in the popup first.');
          renderAll();
          return;
        }
        void patch({ liveExecutionEnabled: value });
      },
    ),
  );

  const modeId = 'field-defaultMode';
  const select = el('select', { attrs: { id: modeId, 'aria-describedby': `${modeId}-hint` } });
  for (const mode of EXECUTION_MODES) {
    const option = el('option', {
      text: EXECUTION_MODE_LABELS[mode],
      attrs: { value: mode, ...(mode !== 'dryRun' && !liveExecutionAllowed(current) ? { disabled: true } : {}) },
    });
    if (current.defaultMode === mode) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => {
    void patch({ defaultMode: select.value as ExecutionMode });
  });

  const modeWrapper = el('div', { className: 'field' });
  modeWrapper.append(
    el('label', { text: 'Mode for new runs', attrs: { for: modeId } }),
    select,
    el('p', {
      className: 'hint',
      text: 'New runs start in this mode. Dry run is the safe default.',
      attrs: { id: `${modeId}-hint` },
    }),
  );
  container.append(modeWrapper);
}

function renderDiagnostics(current: Settings): void {
  renderFields('diagnostics-fields', DIAGNOSTIC_FIELDS, current);

  byId('selector-version').textContent = `Version ${SELECTOR_MAP_VERSION}. Every selector the extension uses lives in one versioned map.`;

  const notes = byId('selector-notes');
  clear(notes);
  for (const note of SELECTOR_MAP_NOTES) {
    notes.append(el('li', { text: note }));
  }
}

function renderDataActions(): void {
  const actions = byId('data-actions');
  clear(actions);

  actions.append(
    button({
      label: 'Export current run (JSON)',
      className: 'btn btn--ghost',
      onClick: () => void exportRun('json'),
    }),
    button({
      label: 'Export current run (CSV)',
      className: 'btn btn--ghost',
      onClick: () => void exportRun('csv'),
    }),
    button({
      label: 'Restore default settings',
      className: 'btn btn--ghost',
      onClick: () => {
        void (async () => {
          const response = await send({ type: 'RESET_SETTINGS' });
          if (response.ok && response.kind === 'settings') {
            settings = response.settings;
            announce('Settings restored to defaults.');
            renderAll();
          }
        })();
      },
    }),
    button({
      label: 'Purge all local data',
      className: 'btn btn--danger',
      onClick: () => {
        const confirmed = window.confirm(
          'Delete all local extension data? This removes settings, the current run state and every stored run log. Your Canva content is not touched.',
        );
        if (!confirmed) return;
        void (async () => {
          const response = await send({ type: 'PURGE_LOCAL_DATA' });
          if (response.ok) {
            announce('Local data purged.');
            await load();
          } else {
            announce(`Could not purge: ${response.message}`);
          }
        })();
      },
    }),
  );
}

async function renderDataSummary(): Promise<void> {
  const snapshot = await fetchSnapshot();
  if (!snapshot) {
    byId('data-summary').textContent = 'No run data stored yet.';
    return;
  }
  const logs = await fetchLogs(snapshot.job.runId);
  byId('data-summary').textContent = `Current run ${snapshot.job.runId}: ${snapshot.job.items.length} item(s), ${logs.length} log event(s) stored.`;
}

function renderAll(): void {
  const current = settings;
  if (!current) return;
  renderExecution(current);
  renderFields('pacing-fields', PACING_FIELDS, current);
  renderFields('discovery-fields', DISCOVERY_FIELDS, current);
  renderFields('override-fields', OVERRIDE_FIELDS, current);
  renderDiagnostics(current);
  renderFields('data-fields', DATA_FIELDS, current);
  renderDataActions();
}

async function exportRun(format: 'json' | 'csv'): Promise<void> {
  const snapshot = await fetchSnapshot();
  if (!snapshot) {
    announce('There is no run to export yet.');
    return;
  }
  const events = await fetchLogs(snapshot.job.runId);
  const now = new Date().toISOString();

  if (format === 'json') {
    const bundle = buildExportBundle(snapshot.job, events, now);
    downloadText(exportFileName(snapshot.job.runId, 'json', now), 'application/json', toJson(bundle));
  } else {
    downloadText(exportFileName(snapshot.job.runId, 'csv', now), 'text/csv', toCsv(events));
  }
  announce(`Exported ${events.length} log event(s).`);
}

async function load(): Promise<void> {
  settings = await fetchSettings();
  if (!settings) {
    announce('Could not reach the extension background worker.');
    return;
  }
  renderAll();
  await renderDataSummary();
}

void load();
