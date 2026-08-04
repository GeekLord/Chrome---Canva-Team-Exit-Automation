# Canva Team Exit Automation

A Manifest V3 Chrome extension that helps a logged-in Canva user copy the designs they own out of a team workspace, verify each copy, move the originals to trash, then leave the team when eligible.

It drives Canva's visible web interface using your existing session. It is a supervised operations tool with a human in the loop, not an unattended bot.

```
copy → verify → trash → leave
```

That order is enforced by the code, not by convention. Nothing is trashed before its copy is verified, and the leave step stays blocked while any selected item is unresolved.

## Requirements

- Google Chrome 110 or newer
- Node.js 20 or newer (for building)
- A Canva account you are signed into in the browser

## Install for development

```bash
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Choose **Load unpacked** and select the `dist` folder

The build writes two passes into `dist`: extension pages plus the service worker (ES modules), and the content script (a single classic IIFE, which is what MV3 content scripts must be).

### Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Full build: pages, worker, then content script |
| `npm run build:pages` | Pass 1 only (popup, options, service worker) |
| `npm run build:content` | Pass 2 only (content script) |
| `npm run watch:pages` | Rebuild pass 1 on change |
| `npm run watch:content` | Rebuild pass 2 on change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit and integration tests, single run |
| `npm run verify` | Typecheck, then tests, then build |

Run the watch scripts in two separate terminals during development, and reload the extension in `chrome://extensions` after a rebuild.

### Before publishing

`public/manifest.json` deliberately ships without an `icons` block, so the build works without binary assets in the repository. Add 16, 32, 48 and 128 pixel PNGs and reference them from the manifest before submitting to the Chrome Web Store.

## Using it

1. Open Canva in a tab and sign in.
2. Open the extension popup. The **Canva tab** panel shows whether a tab was found, whether you look signed in, and which workspace is active.
3. Accept the in-product disclosure. Live execution stays off until you switch it on in **Advanced settings**.
4. Press **Scan teams** to read the workspaces your session can switch into.
5. Tick the source teams to exit, pick a copy destination, and choose an execution mode.
6. Press **Scan designs**. This walks each team's project listing, following the lazy-loading list, and probes a capped number of items to see whether Canva offers a copy action.
7. Review the table. Every row shows owner information, detected copy capability, risk flags and an include/exclude toggle.
8. Tick the confirmations, then start the run. Watch the current action, counters and issues as it goes.
9. When a team's items are done, confirm leaving that team, or choose to finish the team without leaving.
10. Export the run log as JSON or CSV from the report panel.

### Execution modes

| Mode | What happens |
| --- | --- |
| Dry run | Scans and probes only. Never changes anything in Canva. |
| Copy only | Copies each included item to the destination. |
| Copy + verify | Copies, and records how strongly each copy could be verified. |
| Copy + verify + trash | Also moves verified originals to Canva trash. |
| Copy + verify + trash + leave | Full exit, with a separate confirmation per team. |

Dry run is the default in a fresh browser profile. Live modes require both the disclosure and the live-execution toggle.

### Verification strength

Verification is recorded, not assumed:

- **strong** — Canva showed an explicit success confirmation during the copy.
- **weak** — the item was found by title in the destination listing.
- **manual** — you confirmed it yourself.
- **failed** — it could not be confirmed, so the original is left alone and the item is parked for review.

### Second confirmations

The engine asks again before a live run, before trashing, before leaving a team, when more than one team is queued, and when a run exceeds the item threshold (25 by default). Leaving is confirmed once per team, immediately before the leave step.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Keeps settings, run state and logs in local extension storage. |
| `activeTab` | Interacts with the Canva tab you are working in. |
| `scripting` | Injects the content script into a Canva tab that was already open when the extension was installed, so the tool works without a manual reload. |
| `https://www.canva.com/*` | The extension automates Canva's own interface; this is the only site it touches. |

There is no `tabs`, `history`, `downloads` or `clipboard` permission, and no all-sites access. Log exports use a Blob URL and an anchor click from an extension page, which needs no download permission.

## Privacy

Everything is local. Page data is processed in the browser, state is persisted in `chrome.storage.local`, and nothing is transmitted anywhere by default. There is no telemetry and no analytics.

- Exports happen only when you press an export button.
- **Purge all local data** in Advanced settings clears settings, run state, the last report and every stored log in one action.
- Log retention is a configurable cap on the newest events per run.

## How it is put together

```
src/
  background/    service worker, run coordinator, tab control, persistence, pacing
  content/       Canva detection, selector map, DOM utilities, action executors
  popup/         run workflow UI
  options/       advanced settings, diagnostics, local data controls
  shared/        types, schemas, guards, run state machine, planner, report
  logging/       append-only log store, JSON and CSV exporters
  testing/       fixtures, selector mocks, integration harness
```

Four ideas carry most of the weight:

**One state machine.** `src/shared/run-state-machine.ts` is a pure reducer over explicit run and item states. It refuses invalid transitions and logs the refusal rather than failing silently. No booleans stand in for progress.

**One planner.** `src/shared/planner.ts` answers "what is the single next thing to do?" from persisted state alone. Because there is no in-memory cursor, a run resumes correctly after the popup closes, the page reloads, or the service worker is evicted.

**One set of guards.** `src/shared/guards.ts` holds the safety rules. The UI disables controls using the same functions the engine enforces, so the buttons and the engine can never disagree.

**One selector map.** `src/content/selector-map.ts` holds every selector and UI heuristic. Business logic references specs by key. Each spec lists ordered fallback candidates, and failures report per-candidate hit counts so a break is traceable.

### Failure handling

Every failure is normalized into one of the spec's categories: `selector_not_found`, `dialog_not_opened`, `destination_not_found`, `copy_action_missing`, `copy_verification_failed`, `delete_action_missing`, `delete_failed`, `leave_blocked_by_policy`, `auth_required`, `unexpected_navigation`, `rate_limited_or_captcha`, `ownership_ambiguous`, `unknown`.

Each category carries a plain-language explanation, a next step, and a resolution: retry, skip, pause or block. Sign-in walls, CAPTCHA screens and admin leave restrictions halt the run and tell you why; the extension never clicks through a protection screen and never loops on one.

When automation stalls on something a person can do in a second, the run pauses, highlights the item in the page, and waits for you to confirm or skip.

## Canva interface assumptions

Canva publishes no stable DOM contract, so every selector is a heuristic that may need updating.

- Role, `aria-*` and stable visible text are tried before anything else. Hashed CSS class names are never used.
- Visible-text candidates assume the Canva interface is in **English**. On another locale expect `selector_not_found` and fall back to manual assist.
- Copying uses Canva's own copy-to-another-team flow, one item at a time. There is no bulk server-side transfer.
- Trash means Canva's move-to-trash action. Permanent deletion is not automated.
- Leaving a team uses the visible control in Canva settings and can be restricted by team admins.
- Ownership is filtered only where Canva actually shows owner information. Items with no clear owner are listed with an `ownershipUnclear` flag and left unchecked.
- Folder-level migration, separate-account share-and-copy, and screenshot proof records are designed for but not implemented in this version.

The selector map version is shown in the popup footer and in Advanced settings. Quote it in any bug report.

## Tests

```bash
npm test
```

Unit tests cover state transitions, the safety guards, schema validation and settings clamping, error categorization, log export, selector fallback resolution, and listing extraction.

Integration tests in `src/background/run-coordinator.test.ts` drive the real coordinator, tab controller, reducer, guards, log store and storage layer against a fake Canva tab. They assert the things that matter most:

- a dry run sends no mutating request at all
- copy precedes trash for every item
- a failed verification never leads to a trash
- a sign-in wall halts the run and records the interrupted item
- run state survives a service-worker restart and resumes correctly

### Manual QA checklist

Automated tests cannot prove anything about Canva's real interface. Walk these against a live account, starting in dry-run mode:

1. Team with a handful of owned designs.
2. Team large enough to need lazy-loading during discovery.
3. Team where an admin has restricted leaving.
4. An item that offers a copy action, and one that does not.
5. A copy whose verification fails.
6. Trash blocked because the copy was unverified.
7. Pause and resume midway through a batch.
8. Close the popup mid-run, reopen it, and confirm progress is intact.
9. Reload the Canva tab mid-run, then resume.
10. Re-authentication or an unexpected modal appearing mid-run.
11. A multi-team queue with mixed success and failure.
12. Export JSON and CSV, then purge local data.

## Accessibility

Both surfaces are keyboard reachable with visible focus states, form controls have labels, status and progress are announced through live regions, blocking problems use an alert region, and colours are chosen for at least 4.5:1 contrast.

## Reference documents

- `DEVELOPMENT.md` — maintainer notes: build internals, design decisions, invariants that must not regress, testing traps, how to update the selector map
- `canva-team-migration-extension-spec.md` — functional requirements, data model, state machine, error taxonomy
- `canva-team-exit-automation-chrome-web-store-project-info.md` — listing copy, permission justifications, privacy posture
