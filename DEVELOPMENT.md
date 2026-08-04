# Development notes

Maintainer companion to `README.md`. The README explains how to install and use the extension; this file records how it is built, why it is shaped the way it is, and the traps worth knowing before changing it.

Authoritative requirements stay in `canva-team-migration-extension-spec.md` and `canva-team-exit-automation-chrome-web-store-project-info.md`. Read the relevant sections before changing behaviour, and update them when scope shifts.

## Definition of done

```bash
npm run verify     # typecheck, then tests, then both build passes
```

Nothing ships until all three are green:

| Step | Command | Expectation |
| --- | --- | --- |
| Types | `npm run typecheck` | Clean. Strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noUnusedLocals`. |
| Tests | `npm test` | 156 tests across 10 files at time of writing. |
| Build | `npm run build` | `dist/` contains every file `manifest.json` names. |

Post-build sanity checks worth running after touching the build config:

```bash
# The content script must be a classic IIFE. This must print 0.
Select-String -Path dist/content.js -Pattern '^import |^export ' | Measure-Object

# Everything the manifest points at must exist.
$m = Get-Content dist/manifest.json -Raw | ConvertFrom-Json
@($m.background.service_worker, $m.action.default_popup, $m.options_page, $m.content_scripts[0].js[0]) |
  ForEach-Object { "$_ -> " + (Test-Path (Join-Path 'dist' $_)) }
```

A command exiting zero is not evidence the extension works against Canva. See "What is not verified".

## Toolchain

Installed with `--save-exact`, so `package.json` pins versions rather than ranges.

| Package | Version | Role |
| --- | --- | --- |
| `zod` | 4.4.3 | Runtime validation at every boundary |
| `typescript` | 7.0.2 | Typecheck only, no emit |
| `vite` | 8.2.0 | Two-pass MV3 build |
| `vitest` | 4.1.10 | Unit and integration tests |
| `jsdom` | 29.1.1 | DOM environment for selector tests |
| `@types/chrome` | 0.2.5 | Extension API types |

Zod is the only runtime dependency. The UI is plain TypeScript with no framework, which keeps the popup fast and the bundle honest.

## Build: why two passes

MV3 has two incompatible output requirements, so there are two Vite configs and the order matters.

**Pass 1 — `vite.config.ts`.** Extension pages and the service worker. `root` is `src`, `publicDir` is `../public`, `outDir` is `../dist`, and `emptyOutDir` is true. The worker is declared `"type": "module"`, so Rollup is free to emit shared chunks into `dist/assets/`.

**Pass 2 — `vite.config.content.ts`.** The content script only, in `lib` mode with `formats: ['iife']` and `emptyOutDir: false`. MV3 content scripts are classic scripts: no `import`, no shared chunks, one self-contained file.

Consequences to remember:

- **Run pass 1 first.** Pass 2 must not wipe pass 1's output, which is why it does not empty the directory. `npm run build` sequences them correctly; running `build:content` alone against an empty `dist` gives you a content script and nothing else.
- **HTML lands one level deep.** Because `root` is `src`, the pages emit to `dist/popup/index.html` and `dist/options/index.html`. Vite writes absolute asset references (`/popup.js`, `/assets/popup.css`), which is correct here: the extension root *is* `dist`, so those resolve to `chrome-extension://<id>/popup.js`.
- **`entryFileNames` is `[name].js`, unhashed.** The manifest names `service-worker.js` and `content.js` literally, so hashing entries would break it. Chunks and CSS may hash freely.
- **Vite configs are ESM.** `"type": "module"` means `__dirname` does not exist; both configs use `import.meta.dirname`.
- **Source maps are on and minification is off.** Debugging a DOM automation tool against a live site is worth more than a smaller bundle. Revisit only if store review objects.

## Module map

| Path | Owns |
| --- | --- |
| `src/shared/types.ts` | The four canonical entities: `Team`, `DesignItem`, `RunJob`, `LogEvent` |
| `src/shared/schemas.ts` | Zod mirrors of those types, plus compile-time drift assertions |
| `src/shared/guards.ts` | The safety rules, as pure predicates |
| `src/shared/run-state-machine.ts` | The reducer: every state transition, every refusal |
| `src/shared/planner.ts` | "What is the single next action?" |
| `src/shared/factories.ts` | Constructors and counter derivation |
| `src/shared/errors.ts` | The 13-category taxonomy and its operator guidance |
| `src/shared/report.ts` | End-of-run report and dry-run summary derivation |
| `src/shared/messages.ts` | All three message protocols and their schemas |
| `src/shared/settings.ts` | Defaults and clamping |
| `src/background/run-coordinator.ts` | The engine: commands, the action loop, retries, failure routing |
| `src/background/tab-controller.ts` | Finding, navigating and talking to the Canva tab |
| `src/background/storage.ts` | Validated `chrome.storage.local` persistence |
| `src/background/pacing.ts` | Delays, jitter, backoff, service-worker keep-alive |
| `src/background/messaging.ts` | Command surface for the UI |
| `src/background/service-worker.ts` | Wiring and lifecycle only |
| `src/content/selector-map.ts` | Every selector in the project |
| `src/content/dom-utils.ts` | Selector resolution, waiting, clicking, stale recovery |
| `src/content/actions/*` | One playbook per Canva interaction |
| `src/content/detect.ts` | Page detection and interruption detection |
| `src/popup/*` | Run workflow UI |
| `src/options/*` | Advanced settings and diagnostics |
| `src/logging/*` | Append-only log store, JSON and CSV export, file save |
| `src/testing/*` | Fixtures, selector mocks, integration harness |

`src/options/main.ts` imports UI helpers from `src/popup/dom.ts` and `src/popup/format.ts` on purpose: the popup is the primary surface and those helpers are shared UI, not domain code.

## Design decisions

### The reducer owns every transition

`reduceRun(job, event, { now })` is pure and total. It takes `now` as an argument rather than reading the clock, so tests are deterministic. An invalid event returns the job **unchanged** plus a `warn` log event whose action is `reject:<EVENT>`; it never throws and never silently drops. If you add an event, add its refusal path too.

### The planner derives, never remembers

`planNextAction(job)` computes the next action from persisted state alone. There is no in-memory cursor anywhere in the engine. That single property is what makes the run survive a closed popup, a reloaded Canva tab, and an evicted service worker. Keep it that way: if you find yourself caching progress in a field on the coordinator, that is a bug.

### The UI shares the engine's guards

The popup calls `canStartRun`, `canLeaveTeam` and friends to decide what to disable. Because the engine enforces the same functions, a control can never be enabled for something the engine will refuse.

### Navigation lives in the background, not the content script

A page load destroys the content script and any in-flight response with it. So the background navigates first, waits for the script to answer a `PING`, and only then asks for a single-page action. Content actions are strictly within-page.

Two actions can navigate as a side effect anyway: `SWITCH_WORKSPACE` and `LEAVE_TEAM`. Those go through `sendTolerateNavigation`, which turns a lost connection into a reported outcome rather than a failure, so the caller can verify what happened instead of guessing. `confirmTeamGone` does exactly that after a leave: it re-reads Canva's own workspace switcher and checks the team is absent.

Switching workspace prefers navigating to the URL that discovery read from Canva's switcher link. Driving the switcher in the page is the fallback for teams whose link could not be read.

### Verification has a cheap path and an expensive path

Checking the destination listing costs two navigations per item. Canva's own success confirmation costs nothing. So `COPY_ITEM` reports `sawSuccessConfirmation`, which the reducer persists on the item as `copyConfirmationSeen`, and the verify step short-circuits to **strong** without leaving the page. Only when no confirmation was seen does it navigate to the destination, match by title for a **weak** result, and navigate back.

The field has to be persisted rather than held in memory precisely because the run may be interrupted between the copy and the verify.

### Capability probing is capped

Each probe opens one item menu. Probing 300 items would take ten minutes for information the operator mostly needs in aggregate, so `probeItemLimitPerTeam` defaults to 10. Items past the cap keep `copyCapability: 'unknown'` and carry the `copyActionUnknown` risk flag, and the review table says so rather than implying the item was checked.

### Counters are derived, never incremented

`recomputeCounters(job)` recalculates from `items` on every settle. Retries, skips and resumes cannot drift the numbers away from the truth.

### Deliberate extensions to the spec's data model

The spec's entity lists were a starting point. These additions are intentional; extend these types rather than introducing parallel shapes.

| Addition | Why |
| --- | --- |
| `ItemState: 'copied'` | The spec's list had no state for "copy landed, verification pending". Reusing `copyInProgress` would have lied. |
| `DesignItem.copyConfirmationSeen` | Carries the strongest verification signal across the copy/verify boundary. |
| `DesignItem.copyCapability`, `riskFlags`, `attempts`, `lastError` | Needed by the review table, the retry policy and the issues panel. |
| `RunJob.processedTeamIds`, `leftTeamIds` | Make `teamsProcessed` and `teamsLeft` derivable and auditable. |
| `RunJob.settings` | Safety-relevant settings snapshot, so a resumed run cannot become less safe than the one that was reviewed. Pacing is read live so an operator can slow a run mid-flight. |
| `RunJob.manualAssist`, `blocker`, `pauseReason`, `consecutiveFailures`, `currentAction` | Operator-facing state the popup needs without inventing its own. |
| `LogEvent` extra fields | The spec listed a core set; the steering rules require team, item title, result status, verification level and error category on every event. Both are satisfied. |

## Invariants that must not regress

Each of these exists because of a bug found during implementation. The listed test is the one that will catch a regression.

1. **Nothing is trashed without a completed copy.** `canTrashItem` requires `copyStatus === 'copied'`, and verification on top unless the operator set the explicit override. `TRASH_STARTED` re-checks the guard as defence in depth and parks the item for review if it somehow gets there, so the engine cannot spin on it. — `run-state-machine.test.ts`, `guards.test.ts`
2. **A blocked or failed action always logs its error category.** The blocked-trash path originally logged a message with no category, losing the audit trail on the event that matters most. — `run-state-machine.test.ts`
3. **`describeThrown` always returns a string.** It runs inside the failure path, so it must not be capable of throwing or of yielding `undefined`. A thrown `undefined` used to crash the error handler. — `errors.test.ts`
4. **A container must never stand in for the control inside it.** The `label` selector strategy matches only a *declared* accessible name (`declaredAccessibleName`). Falling back to descendant text let `[role="menu"]` match as though it were the entry inside it. — `dom-utils.test.ts`
5. **A halting failure records the item's step failure before blocking the run.** Leaving an item in `deleteInProgress` meant a later resume silently retried a trash whose outcome nobody had checked. — `run-coordinator.test.ts`
6. **A failed leave withdraws that team's confirmation.** Otherwise the planner immediately re-proposes `leaveTeam` and loops. The state goes to `awaitingLeaveConfirmation` and waits for a fresh, deliberate confirm. — `run-state-machine.test.ts`, `planner.test.ts`
7. **Retrying an item after a run has finished reopens the run.** The planner returns null for terminal states, so the retry button was a dead control. `ITEM_RETRY_REQUESTED` now clears `endedAt`, sets the item's team active, and un-marks it processed. — `run-state-machine.test.ts`
8. **Dry run reaches no mutating action.** Two independent locks: the planner never proposes one, and `assertMutationAllowed` in the content script refuses one if asked. — `run-coordinator.test.ts`
9. **Export never lets user text become a spreadsheet formula.** Design titles are user-controlled; `escapeCsvCell` prefixes a leading `=`, `+`, `-` or `@`. Filenames drop dots so a run id cannot contribute `..`. — `exporters.test.ts`
10. **The pacing floor cannot be edited away.** `clampSettings` re-applies `MIN_ACTION_DELAY_MS` on every read, so a hand-edited storage blob cannot make the extension click at machine speed. — `schemas.test.ts`

### Recovery bias

`RUN_RECOVERED` treats the two interrupted steps differently, and the asymmetry is the point:

- `copyInProgress` → `copyPending`, requeued. A duplicate in the destination is recoverable.
- `deleteInProgress` → `manualReviewRequired`, parked. Whether the trash landed is unknown, and a lost original is not recoverable.

`needsRecovery(job)` gates the whole thing so that routine worker eviction does not write a recovery entry to the log on every wake.

## Testing

### The injectable wait, and the trap in it

`RunCoordinator` and `TabController` both accept a `wait` function. Production uses the real pacing from `pacing.ts`; the integration tests inject `immediateWait` from `src/testing/harness.ts`.

**Do not inject a synchronous no-op.** The engine's polling loops (`waitForContentReady`, `waitForView`, the action loop) are bounded by wall-clock time. With an instantly-resolving wait they run entirely in the microtask queue, starve the timer queue, and any `setTimeout` in the test never fires. That presents as a hang, not a fast test. `immediateWait` yields a macrotask via `setTimeout(resolve, 0)`, which keeps the loops honest.

This cost real debugging time: the first version of the suite took 53 seconds and timed out on four tests for exactly this reason. It now runs in about 2.5 seconds.

### Waiting for the engine to come to rest

`settle(rig)` in `run-coordinator.test.ts` polls until `!engineBusy` and there is nothing left to plan, then returns; it throws after a bounded number of ticks so a stuck engine fails an assertion instead of hanging the suite. Note that `awaitLeaveConfirmation` counts as **rest**, not pending work — it is the engine correctly waiting for a human.

### The fake Canva tab

`src/testing/harness.ts` installs a `chrome` global covering only what the extension uses (`storage.local`, the `tabs` surface reachable with host permissions, and a `scripting.executeScript` stub) and answers the same validated `ContentRequest` protocol the real content script does. That is what makes the integration tests worth having: they exercise the real coordinator, tab controller, reducer, guards, log store and storage layer.

`makeFakeCanva` can script per-request-type failures, toggle whether the copy shows a confirmation, seed destination titles, and force an interruption or a leave outcome. `fakeItems` mirrors real discovery, including the `copyActionUnknown` flag.

### Where jsdom matters

`dom-utils.test.ts` and `item-cards.test.ts` opt into jsdom with a `// @vitest-environment jsdom` docblock. jsdom has no layout engine, so `isVisible` degrades deliberately: when no layout information exists it trusts explicit hiding signals (`aria-hidden`, `hidden`, computed `display`/`visibility`/`opacity`) instead of reporting everything as invisible. jsdom also does not implement `innerText`, which is why `visibleText` and `rawText` both fall back to `textContent`.

Design ids in mocks must be at least six characters. `extractCanvaDesignId` requires that, matching real Canva ids, and short ids silently fall back to title matching — which once made a dedupe test pass for the wrong reason.

## Maintaining the selector map

`SELECTOR_MAP_VERSION` in `src/content/selector-map.ts` is shown in the popup footer and in Advanced settings. Bump it whenever you change a candidate, and ask for it in bug reports.

When Canva breaks something:

1. Turn on **Debug mode** in Advanced settings and reproduce. `selector_not_found` details include `describeSpecFailure` output: per-candidate hit counts, the strategy, and the candidate description.
2. Fix the map, never the call site. Business logic references specs by key and must stay free of raw selectors.
3. Add candidates, do not replace them, unless the old markup is definitely gone. The ordering is the fallback chain.
4. Prefer role, `aria-*` and stable visible text. Hashed CSS class names are not acceptable candidates.
5. Add a mock to `src/testing/selector-mocks.ts` reproducing the new shape, and a resolution test.

Watch the CSS precedence trap: in a selector list, commas bind looser than the descendant combinator, so `'[role="menu"], button'` means "any menu **or** any button", not "a button inside a menu". Specs that are always resolved with a root element passed in should list plain descendants in `within`; the root does the scoping. Getting this wrong once made a menu-scoped candidate match every link on the page.

## Common changes

**Add a settings field.** `Settings` in `types.ts`, `settingsSchema` in `schemas.ts`, a default in `DEFAULT_SETTINGS`, a clamp in `clampSettings` if numeric, then a field spec in the relevant array in `src/options/main.ts`. The compile-time assertions in `schemas.ts` fail if the type and the schema drift.

**Add a run event.** The `RunEvent` union and a `case` in `reduceRun` (including its refusal path), then dispatch it from the coordinator. If it introduces new work, teach `planNextAction` to propose it and decide whether it is mutating.

**Add a Canva interaction.** A new executor under `src/content/actions/`, a variant in `contentRequestSchema`, a result schema, a `case` in the content router with an entry in `FALLBACK_CATEGORY`, and a call from the coordinator through `withRetries`. Mutating actions must call `assertMutationAllowed` first.

**Add an error category.** Append to `ERROR_CATEGORIES` and add its `ERROR_GUIDANCE` entry — explanation, next step, first-choice resolution and escalation. `errors.test.ts` asserts every category has real guidance. Decide whether it belongs in `isHaltingCategory` or `MANUAL_ASSIST_CATEGORIES`.

**Add a UI command.** `uiCommandSchema`, a coordinator method returning `CommandOutcome`, a `case` in `handleUiCommand`, then the control in the popup or options page.

## Numbers worth knowing

| Setting | Default | Bound |
| --- | --- | --- |
| `actionDelayMs` | 1200 | floor 400, ceiling 30000 |
| `actionJitterMs` | 700 | 0 to 30000 |
| `actionTimeoutMs` | 15000 | 2000 to 120000 |
| `discoveryTimeoutMs` | 90000 | 5000 to 600000 |
| `maxRetriesPerAction` | 2 | 0 to 10 |
| `backoffMultiplier` | 2 | 1 to 10 |
| `circuitBreakerThreshold` | 5 | 1 to 100 |
| `confirmationItemThreshold` | 25 | 1 to 10000 |
| `probeItemLimitPerTeam` | 10 | 0 to 500 |
| `logRetentionMaxEvents` | 5000 | 100 to 20000 |

Hard-coded limits: `MAX_LOOP_ITERATIONS` 5000 (engine spin backstop), `MAX_ITEMS` 2000 per discovery pass, `STABLE_ROUNDS_REQUIRED` 3 (lazy-list end detection), `MAX_SEARCH_ROUNDS` 12 (destination scan during verification), navigation budget `max(20s, actionTimeoutMs)`.

## Storage keys

All in `chrome.storage.local`. Nothing is written to `chrome.storage.sync`: run state and logs stay on the machine that produced them.

| Key | Contents |
| --- | --- |
| `ctea.settings.v1` | `Settings` |
| `ctea.run.active.v1` | The single in-progress or most recent `RunJob` |
| `ctea.run.lastReport.v1` | Last finished run's report |
| `ctea.logs.index.v1` | Array of run ids that still have logs |
| `ctea.logs.run.<runId>` | That run's `LogEvent[]`, capped by retention |

`ctea.keepalive` is read but never written: touching storage every 20 seconds during a run resets the MV3 idle timer without needing the `alarms` permission. Reads are validated with Zod and degrade to a safe default with a logged reason rather than throwing inside the worker. `allPurgeableKeys` drives the one-click purge.

## Permissions

`storage`, `activeTab`, `scripting` and `https://www.canva.com/*` — matching the justification table in the store listing document. Each is genuinely used; `scripting` earns its place through on-demand content-script injection for a Canva tab that was already open when the extension was installed, so the tool works without asking for a manual reload. Re-injection is safe: the content script guards its listener with a window flag.

Do not add `tabs`, `history`, `downloads`, `clipboard` or broad host access. Log export deliberately uses a Blob URL plus an anchor click from an extension page, which needs no download permission. There is no telemetry; if analytics are ever introduced they must be opt-in and anonymised.

## What is not verified

Be honest about this in any handover.

- **The selector map has never met Canva.** Every candidate is a heuristic tested against mock DOM only. Treat the map as the most likely thing to be wrong.
- **English only.** Visible-text candidates assume an English interface. Other locales should expect `selector_not_found` and manual assist.
- **The manual QA checklist in the README has not been run** against a live account. It is the actual acceptance gate for anything touching `src/content/`.
- **No icons.** `public/manifest.json` ships without an `icons` block so the build needs no binary assets. Add 16/32/48/128 PNGs before store submission.
- **Accessibility is coded for, not audited.** Labels, focus states, live regions and contrast ratios were built in deliberately, but full conformance needs manual testing with assistive technology and expert review.

## Deferred, with hooks in place

| Feature | Where it plugs in |
| --- | --- |
| Separate-account share-and-copy destination | `DestinationKind: 'separateAccountShareCopy'` exists and is refused by `canStartRun` and `copyItem` |
| Folder-level migration | Folders are discovered, flagged `itemTypeUnsupported` and left unchecked |
| Screenshot proof records | `LogEvent.screenshotRef` is threaded through and always null |
| Better ownership inference | `OwnerConfidence` and the `ownershipUnclear` flag already carry the uncertainty |

None of these should be started without re-reading the spec sections that describe them.
