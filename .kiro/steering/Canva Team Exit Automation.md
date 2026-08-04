---
inclusion: always
---

# Canva Team Exit Automation

A Manifest V3 Chrome extension that helps a logged-in Canva user copy designs they own out of a team workspace, verify each copy, optionally trash the originals, then leave the team. It drives Canva's visible web UI using the user's existing session. Treat it as a supervised, human-in-the-loop operations tool, never an unsupervised bot.

Authoritative requirements live in two workspace docs. Read the relevant sections before implementing or changing behavior, and keep them in sync when scope shifts:

- `canva-team-migration-extension-spec.md` — functional requirements, data model, state machine, error taxonomy.
- `canva-team-exit-automation-chrome-web-store-project-info.md` — listing copy, permission justifications, privacy posture.

## Non-negotiable workflow order

`copy → verify → trash → leave`. Never reorder these steps, never skip verification.

- Nothing is trashed until its copy status is `copied` or `copyVerified`.
- Trash means Move to Trash. Do not implement permanent deletion in v1.
- The team leave action stays blocked while any selected item is unresolved, unless the user sets an explicit advanced override.
- Dry-run is the default in a fresh browser profile. Live execution requires deliberate opt-in.
- Require a second confirmation before trashing, leaving a team, running multi-team batches, and exceeding the configured item threshold (default 25–50).
- Process items sequentially. Canva copies one item at a time, so never simulate bulk server-side transfer.

## Scope guardrails

Single purpose: migrate designs the user owns out of a Canva team and help them exit it. Keep code, permissions, and user-facing copy aligned to exactly that.

Do not:

- Call private, undocumented, or reverse-engineered Canva APIs. UI automation only.
- Bypass Canva permissions, access checks, rate limits, or abuse protection.
- Touch billing, seat assignment, or admin-level team settings beyond the leave flow.
- Request permissions outside `storage`, `activeTab`, `scripting`, and Canva host permissions. No `tabs`, `history`, `downloads`, `clipboard`, or broad all-sites access.
- Add telemetry or analytics. If analytics are ever introduced, they must be opt-in and anonymized.

## Architecture

TypeScript with strict typing, Vite-style MV3 build, Zod or equivalent for runtime validation at boundaries.

Module layout:

- `src/background/` — service worker, messaging, run coordination, job persistence
- `src/content/` — Canva detection, selector map, action executors, DOM utilities
- `src/popup/` — run workflow UI
- `src/options/` — advanced settings, pacing, debug mode
- `src/shared/` — types, schemas, storage keys, constants, run state machine
- `src/logging/` — event log writers and exporters
- `src/testing/` — fixtures, selector mocks, harness helpers

Patterns to follow:

- Run orchestration is an event-driven reducer/state machine. Both the run and each item carry explicit states from the spec. No ad-hoc booleans standing in for progress.
- Canva interactions are discrete playbook-style action executors invoked by the engine. UI code never calls them directly.
- `Team`, `DesignItem`, `RunJob`, and `LogEvent` are the canonical entities. Extend those types instead of introducing parallel shapes.
- Unit-test state transitions, validation, log export, selector fallback resolution, and error categorization. Integration-test content/background messaging, persistence and resume, and dry-run generation.

## Canva DOM automation rules

- Every selector and UI heuristic belongs in a single versioned selector map under `src/content/`. Business logic must never contain a raw selector.
- Prefer roles, `aria-*` labels, and stable visible text over CSS class names. Provide fallback paths per action.
- Each action needs a timeout, bounded retries, and stale-DOM recovery. Assume Canva's UI will change under you.
- Pace actions with configurable delays plus jitter, and back off after repeated failures.
- Detect CAPTCHA, re-authentication, and abuse-prevention screens, then halt and alert the user. Never loop indefinitely.
- Where automation confidence is low, fall back to manual assist: highlight the item, state the next step, wait for user confirmation.

## Data, privacy, logging

- Local-first. Process page data in the browser, persist state in `chrome.storage`, transmit nothing externally by default.
- Export logs as JSON and CSV only on explicit user action. Provide one-click purge of local data.
- Keep an append-only run log. Every action emits a `LogEvent` carrying run ID, timestamp, source team, item title, action, result status, verification level, and error category.
- Verification strength is first-class. Record whether it was strong (explicit Canva confirmation), weak (title match in destination), or manual.
- Closing the popup or refreshing the page must not lose run state. Resume from the last unresolved item.
- Show an in-product disclosure with explicit consent before the first live run.

## Error handling

Normalize failures to the spec's categories: `selector_not_found`, `dialog_not_opened`, `destination_not_found`, `copy_action_missing`, `copy_verification_failed`, `delete_action_missing`, `delete_failed`, `leave_blocked_by_policy`, `auth_required`, `unexpected_navigation`, `rate_limited_or_captcha`, `ownership_ambiguous`, `unknown`.

Each error logs raw detail, surfaces a plain-language explanation with a next step, and resolves to retry, skip, pause, or block. No silent failures.

## UI conventions

- Operations-console feel over consumer polish: current action text, progress counters, error summary, and a prominent execution-mode badge.
- Pre-run review screen lists team, item title, owner info, detected copy capability, risk flags, and an include/exclude toggle per item.
- End-of-run report covers teams processed, items found, copied, verified, trashed, failed, skipped, teams left, and blocking issues.
- Keyboard accessible throughout: tab-reachable controls, visible focus states, labeled status regions, screen-reader-friendly progress and blocking messages, sufficient contrast.

## Wording

Use "copy" and "trash", not "transfer" and "delete". Say "leave the team when eligible" because admins can restrict it. Never promise one-click bulk migration.
