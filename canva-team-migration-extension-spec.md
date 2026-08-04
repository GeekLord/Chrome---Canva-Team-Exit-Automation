# Canva Team Exit Automation Chrome Extension — Specification and Project Requirements

## Purpose

Build a Chrome extension that helps a Canva user safely migrate their own designs out of Canva teams and then leave those teams. The extension must automate a browser-driven workflow, not rely on undocumented Canva backend APIs.

The extension should perform the following sequence for one or more selected Canva teams:

1. Discover designs owned by the current user inside the selected team.
2. Copy each eligible design to the user’s personal Canva space or a designated destination team/account.
3. Verify copy success for each design.
4. Delete or trash the original design from the source team only after successful verification.
5. Leave the source team only after all selected designs are processed and the user confirms the action.

Canva’s help documentation states that designs/files can be copied to another team or account, and that copying between teams is currently done one design, file, or folder at a time.[cite:1] Canva also documents a UI-based workflow for leaving a team, and notes that team-leaving can depend on admin permissions.[cite:4]

## Project Context

The user belongs to many Canva teams and wants a repeatable semi-automated workflow that minimizes manual effort while prioritizing safety. The browser extension should act as an expert operator on top of Canva’s existing UI and user session.

This is not a fully headless background migration tool. It is a supervised browser automation tool with strong guardrails, visible progress, resumability, and explicit confirmations before destructive actions.

## Key Constraints

### Platform constraints

- Target platform: Google Chrome desktop, Manifest V3.
- The extension must work as a content-script-driven automation assistant against the Canva web app.
- No dependency on private, reverse-engineered, or undocumented Canva APIs for core functionality.
- All core operations must be achievable through visible browser UI automation and DOM/event interaction.

### Canva workflow constraints

- Copying is supported by Canva, but documented as a copy workflow rather than a true transfer workflow.[cite:1]
- Copying between teams is documented as one item at a time, so any bulk workflow must internally process items sequentially.[cite:1]
- Leaving a team may be blocked if the team admin has restricted who can leave.[cite:4]
- The user loses access to team assets after leaving, so the extension must enforce copy-verification before leave actions.[cite:4]

### Product constraints

- Destructive steps must never run blindly.
- Every design operation must be auditable in a run log.
- The user must be able to stop, pause, resume, retry, or skip items.
- The extension must be resilient to Canva UI changes where possible, but the implementation should assume selectors may break over time.

## Goals

### Primary goals

- Reduce repetitive manual work when exiting many Canva teams.
- Safely copy user-owned designs out of a source team.
- Delete originals only after successful copy verification.
- Leave source teams only after successful migration and explicit confirmation.

### Secondary goals

- Allow dry-run analysis before making changes.
- Provide recoverable and resumable jobs.
- Support multiple destination modes if feasible.
- Produce detailed logs for troubleshooting and audit.

## Non-goals

- Do not implement unsupported direct server-side transfer operations.
- Do not manage billing, seat assignment, or admin-level team settings outside the specific leave workflow.
- Do not attempt to migrate content the user does not own unless the user explicitly chooses a broader mode and Canva UI permits it.
- Do not scrape or export private content outside what is necessary for the copy-delete-leave workflow.
- Do not bypass Canva permissions, access checks, rate limits, or security controls.

## Supported Use Cases

### Core use case

A user opens Canva in Chrome while logged in, launches the extension, selects one or more teams from a detected list, reviews a dry-run summary of owned designs, chooses a destination, and starts a supervised migration job.

### Destination modes

Implement support for these modes, in order of priority:

1. **Same-login personal/team destination mode**: The destination is a switchable personal/team workspace visible within the current Canva account session. This is the preferred path because Canva documents copy-to-another-team within the UI.[cite:1]
2. **Separate account destination via share-and-copy mode**: The destination is another Canva account, using Canva’s documented share/edit-link plus “Make a copy” style workflow.[cite:1]

The first mode is required for v1. The second mode may be implemented only if the developer can make it sufficiently reliable; otherwise leave it as a deferred feature with hooks in the architecture.

### Team exit use case

After all selected designs from a team are successfully copied and verified, the user can review a summary and confirm leaving the team. The extension then navigates through the documented team leave flow in Canva settings.[cite:4]

## User Personas

### Primary user

A technically capable power user who belongs to many Canva teams and wants safe bulk assistance rather than a black-box “one click” action.

### Secondary user

An operations user or freelancer leaving client, school, agency, or shared Pro teams and wanting proof that their own work has been preserved before exiting.

## Safety Principles

The extension must be designed around a “copy first, verify second, delete third, leave last” policy. No step may violate this order.

The extension must default to dry-run mode for first use in a browser profile. The user must explicitly enable live execution.

The extension must require an additional confirmation before:

- Starting deletion/trash operations.
- Leaving a team.
- Running on more than one team in a single batch.
- Running on more than a configurable threshold of items, for example 25 or 50.

The extension must maintain an append-only event log for each run, including timestamps, team identifiers, design titles, action attempts, outcome status, and any error message.

## Functional Requirements

## FR-1 Team discovery

The extension shall detect available Canva teams accessible in the current session.

Required capabilities:

- Detect the current active team/workspace.
- Enumerate switchable teams/workspaces shown in the Canva UI.
- Capture display name and stable URL or inferred identifier for each team if available.
- Present the list in the extension UI for user selection.

Acceptance criteria:

- The extension shows all visible teams/workspaces that the current user can switch into from the current session.
- The extension can switch into a selected source team.

## FR-2 Destination selection

The extension shall allow the user to select a copy destination.

Required capabilities:

- List switchable destinations visible in the same session.
- Allow configuration of a preferred default destination.
- For future cross-account mode, store destination metadata needed for share-and-copy workflow.

Acceptance criteria:

- The user can choose one destination per run.
- The destination selection is validated before execution starts.

## FR-3 Design discovery and filtering

The extension shall discover candidate designs inside the selected team.

Required capabilities:

- Navigate to the relevant Canva Projects/Designs view.
- Enumerate visible design cards/items through pagination or infinite scroll.
- Capture per-item metadata where available: title, URL, folder, type, owner indicator, last modified, thumbnail presence.
- Filter to “owned by me” items where Canva UI exposes owner information.
- Allow user review of the discovered items before execution.

Optional capabilities:

- Include folder traversal.
- Include file types beyond designs if Canva presents copyable files in the same workflow.

Acceptance criteria:

- The extension can produce a reviewable list of candidate items for a selected team.
- The user can exclude individual items before execution.

## FR-4 Dry-run analysis

The extension shall provide a non-destructive dry-run mode.

Required capabilities:

- Discover teams and items.
- Determine likely automatable actions available on each item.
- Estimate copy feasibility and possible blockers.
- Show counts: total found, selected, copyable, blocked, ambiguous.

Acceptance criteria:

- The user can run the extension in dry-run mode without triggering any Canva mutation action.
- A dry-run report is shown before live execution begins.

## FR-5 Item copy workflow

The extension shall automate copying a selected design from the source team to the destination.

Preferred v1 implementation:

- From the Projects or design-item menu, use Canva’s native “Copy to another team” UI if present.[cite:1]
- If the item must be opened first, the extension may open the design and invoke the copy flow from there.

Required capabilities:

- Process one item at a time.
- Detect copy dialog appearance.
- Select the configured destination.
- Confirm the copy action.
- Wait for visible success state or destination confirmation.

Acceptance criteria:

- Each item receives a final status of copied, skipped, failed, or unknown.
- No item is deleted unless its copy status is copied or verified-copied.

## FR-6 Copy verification

The extension shall verify copy success before allowing deletion.

Verification strategies, ordered by preference:

1. Presence of explicit Canva success toast or confirmation dialog.
2. Presence of copied item in destination Projects view with matching or near-matching title.
3. Re-opened item check using destination context where feasible.
4. Manual verification fallback requiring user approval.

Required capabilities:

- Record the verification method used for each item.
- Distinguish between “copy attempted” and “copy verified.”

Acceptance criteria:

- The UI and logs clearly show whether verification is strong, weak, or manual.
- Deletion is blocked for unverified items unless the user overrides with an advanced explicit setting.

## FR-7 Deletion/trash workflow

The extension shall automate removing the original design from the source team only after copy verification.

Required capabilities:

- Use Canva’s documented delete/trash action via the item menu.[cite:1]
- Confirm deletion if Canva presents a confirmation dialog.
- Update logs with trash success or failure.

Safety rules:

- Default behavior is Move to Trash, not permanent deletion.
- Permanent deletion must not be implemented in v1 unless unavoidable in Canva UI and separately confirmed.
- If a delete action fails, the team leave flow must remain blocked until resolved or explicitly overridden.

Acceptance criteria:

- Items are never trashed before verified copy status.
- The user can configure “copy only” mode that performs no deletion.

## FR-8 Team leave workflow

The extension shall help the user leave a team after migration.

Required capabilities:

- Navigate to the team settings or profile area that exposes the leave control.
- Detect whether the leave action is available or blocked.
- Present a pre-leave checklist showing unresolved items and risks.
- Require explicit confirmation before leaving.
- Execute the leave action through Canva’s UI if allowed.[cite:4]

Acceptance criteria:

- The team leave button is disabled in the extension UI until all required checks pass or the user explicitly overrides.
- If Canva blocks leaving due to admin policy, the extension reports this clearly and does not loop indefinitely.[cite:4]

## FR-9 Batch processing

The extension shall support processing multiple teams in sequence.

Required capabilities:

- Queue multiple source teams.
- Execute them one team at a time.
- Show per-team and overall progress.
- Pause between teams for user confirmation, at least in default safe mode.

Acceptance criteria:

- The user can select several teams and process them as separate queued jobs.
- A failure in one team does not corrupt logs for other teams.

## FR-10 Pause, resume, retry, skip

The extension shall support operational control during a run.

Required capabilities:

- Pause after the current atomic action completes.
- Resume from the last unresolved item.
- Retry a failed item.
- Skip an item and continue.
- Stop the run safely.

Acceptance criteria:

- The extension never leaves a single item mid-action without recording the last known state.
- The run can be resumed after browser refresh if feasible via extension storage.

## FR-11 Logging and export

The extension shall maintain detailed run logs.

Required fields:

- Run ID
- Timestamp
- Source team
- Destination
- Design title
- Design URL if available
- Detected owner info if available
- Action type
- Result status
- Verification level
- Error category
- Raw error text or normalized code

Required capabilities:

- View logs inside the extension.
- Export logs as JSON and CSV.
- Surface a concise end-of-run summary.

Acceptance criteria:

- Every design action is represented in the log.
- Logs are preserved across extension popup close events.

## FR-12 Selector strategy and resilience

The extension shall use a robust DOM automation strategy.

Required approach:

- Prefer semantic selectors, aria labels, stable text, and role-based queries over brittle CSS class names.
- Centralize all selectors and UI heuristics in a versioned selector map.
- Include fallback selector paths per action.
- Include timeouts, retries, and stale DOM recovery.

Acceptance criteria:

- The codebase isolates Canva-specific selectors from business logic.
- Updating selectors should not require rewriting orchestration logic.

## FR-13 Rate limiting and pacing

The extension shall avoid overly aggressive automation.

Required capabilities:

- Configurable action delays and random jitter.
- Max retry limits.
- Backoff after repeated failures.
- Detection of unexpected CAPTCHA, auth, or abuse-protection screens.

Acceptance criteria:

- The extension does not click through Canva screens at machine-speed continuously.
- The extension halts and alerts the user when abuse-prevention or re-authentication is suspected.

## FR-14 Manual assist mode

The extension shall support a partially assisted workflow.

Required capabilities:

- Highlight the current item being processed.
- Present next required manual step if automation confidence is low.
- Wait for user confirmation and continue.

Acceptance criteria:

- The extension remains usable even when a specific sub-step cannot be safely automated.

## FR-15 Configurable execution modes

The extension shall support these modes:

- Dry-run only
- Copy only
- Copy + verify
- Copy + verify + trash
- Copy + verify + trash + leave team

Acceptance criteria:

- The chosen mode is shown prominently in the UI before the run starts.
- Dangerous modes require extra confirmation.

## Data Model Requirements

Define explicit data structures for the following entities:

### Team

Fields:

- internalId
- displayName
- workspaceUrl
- leaveSupportedState
- discoveryTimestamp

### DesignItem

Fields:

- internalId
- title
- sourceUrl
- sourceTeamId
- folderPath
- itemType
- ownerLabel
- ownerConfidence
- discoveredAt
- selected
- copyStatus
- verificationStatus
- deleteStatus
- notes

### RunJob

Fields:

- runId
- mode
- createdAt
- startedAt
- endedAt
- sourceTeams[]
- destination
- counters
- state
- userOverrides

### LogEvent

Fields:

- eventId
- runId
- timestamp
- level
- entityType
- entityId
- action
- message
- detail
- screenshotRef optional

## Architecture Requirements

Use a modular Chrome extension architecture.

### Required components

- **Popup UI** for launch, configuration, and high-level progress.
- **Options page** for advanced settings, selector tuning, delays, export preferences, and debug mode.
- **Content scripts** for Canva page detection, DOM automation, item discovery, and workflow execution.
- **Background service worker** for run coordination, storage orchestration, alarms/timers if needed, and long-lived state management.
- **Shared domain layer** containing state models, run engine, action types, and validation logic.

### Strongly recommended implementation style

- TypeScript
- Strict typing
- Event-driven run engine
- Reducer/state-machine-based workflow orchestration
- Playbook-like action executors for each Canva interaction

## Suggested Module Breakdown

- `src/background/` — service worker, messaging, job persistence
- `src/content/` — Canva detectors, selectors, action executors, DOM utilities
- `src/popup/` — user workflow UI
- `src/options/` — configuration UI
- `src/shared/` — types, schemas, storage keys, constants, run state machine
- `src/logging/` — event log writers, exporters
- `src/testing/` — selector mocks, fixtures, test harness helpers

## Workflow State Machine

Represent the run as a formal state machine.

Suggested top-level states:

- idle
- discoveringTeams
- selectingTeams
- discoveringItems
- reviewReady
- awaitingStartConfirmation
- copying
- verifying
- trashing
- awaitingLeaveConfirmation
- leavingTeam
- paused
- completed
- completedWithWarnings
- failed
- blocked

Each design item should also have an item-level state machine, for example:

- discovered
- selected
- copyPending
- copyInProgress
- copyFailed
- copyVerified
- deletePending
- deleteInProgress
- deleteFailed
- completed
- skipped
- manualReviewRequired

## UI/UX Requirements

The extension should feel like an operations console rather than a casual consumer app.

### Popup requirements

Show:

- Current Canva page detection state
- Logged-in status heuristic
- Current workspace/team
- Button to scan teams
- Destination selector
- Mode selector
- Dry-run summary
- Start/pause/resume/stop controls
- Live current action text
- Progress counters
- Error summary

### Review screen requirements

Before execution, show a table-like review list with:

- Team
- Item title
- Owner info
- Detected copy capability
- Risk flags
- Include/exclude checkbox

### End-of-run report

Show:

- Total teams processed
- Total items found
- Copied count
- Verified count
- Trashed count
- Failed count
- Skipped count
- Teams left count
- Blocking issues

## Error Handling Requirements

Implement normalized error categories.

Required categories:

- selector_not_found
- dialog_not_opened
- destination_not_found
- copy_action_missing
- copy_verification_failed
- delete_action_missing
- delete_failed
- leave_blocked_by_policy
- auth_required
- unexpected_navigation
- rate_limited_or_captcha
- ownership_ambiguous
- unknown

For each error, the extension must:

- Log the raw details.
- Surface a human-readable explanation.
- Offer next-step guidance where feasible.
- Decide whether the workflow should retry, skip, pause, or block.

## Persistence Requirements

Use Chrome extension storage to persist:

- User settings
- Selected default destination
- Last run summary
- In-progress run state where feasible
- Logs and exports index

Requirements:

- Closing the popup must not lose run state.
- A page refresh should allow the run to be recovered where feasible.
- Data retention should be configurable.

## Security and Privacy Requirements

The extension will operate on user content, so privacy expectations must be explicit.

Requirements:

- Minimal permissions principle.
- Request host permissions only for Canva domains required to operate.
- Do not send design metadata, thumbnails, or logs to remote servers by default.
- All processing should be local unless the user explicitly opts into diagnostics export.
- Clearly disclose what is stored locally.
- Provide a one-click option to purge local data.

Do not implement any hidden telemetry. If analytics exist at all, they must be opt-in and anonymized.

## Permissions Guidance

Likely required Chrome permissions:

- `storage`
- `activeTab`
- `scripting`
- Host permissions for Canva web domains used by the logged-in app experience

The final permissions list should be justified and kept minimal.

## Performance Requirements

- The extension should remain responsive while scanning large teams.
- Item discovery must support lazy-loading/infinite-scroll pages.
- The UI should not freeze during long runs.
- Batch operations should include pacing and bounded memory use.

Target operational behavior:

- Scan several hundred items without crashing the popup.
- Continue processing when Canva re-renders lists dynamically.

## Accessibility Requirements

The extension UI must be keyboard accessible.

Requirements:

- Reachable controls via tab navigation.
- Visible focus states.
- Proper labeling for status, warnings, and action buttons.
- Sufficient contrast.
- Screen-reader-friendly status text for progress and blocking errors.

## Testing Requirements

The project must include automated and manual test strategies.

### Unit tests

Cover:

- State machine transitions
- Validation logic
- Log formatting/export
- Selector fallback resolution
- Error categorization

### Integration tests

Cover:

- Content-script messaging with background worker
- Persistence and resume behavior
- Dry-run generation

### Manual QA scripts

Provide documented test scenarios for:

1. Team with a few owned designs.
2. Team with many designs and infinite scroll.
3. Team where leave is blocked by admin policy.[cite:4]
4. Item with copy available.
5. Item with copy action missing.
6. Verification failure.
7. Deletion disabled due to unverified copy.
8. Pause/resume during batch processing.
9. Canva re-authentication or unexpected modal interruption.
10. Multi-team queue with mixed success/failure outcomes.

## Observability and Debugging

Include a debug mode with:

- Verbose action logs
- Selector match diagnostics
- Step timers
- Screenshot capture hooks if technically practical
- Downloadable diagnostic bundle as JSON

Debug mode must be clearly separated from normal mode to avoid overwhelming end users.

## Deliverables

The expert extension developer agent should produce:

1. A production-ready Chrome extension codebase using Manifest V3.
2. TypeScript source code with clear module boundaries.
3. A README with install, dev, build, and usage instructions.
4. A configuration document describing selectors and Canva workflow assumptions.
5. A QA checklist and test plan.
6. Exportable run logs in JSON and CSV.
7. Optional screenshots or GIFs showing the main workflow.

## Suggested Technical Stack

Preferred stack:

- TypeScript
- Vite or equivalent extension-friendly build setup
- React, Preact, or plain TS for popup/options UI
- Zod or equivalent for runtime schema validation
- Lightweight state machine library or custom reducer-based engine
- CSV export utility

The developer may choose alternatives if they improve reliability and keep the extension maintainable.

## Deferred Features

These should be designed for extensibility but may be postponed beyond v1:

- Separate-account share-and-copy mode with cross-profile assistance.[cite:1]
- Folder-level migration orchestration where Canva supports it.[cite:1]
- Screenshot-based proof records for each copied item.
- Advanced heuristics for ownership inference.
- Template-link based workflows if they prove more reliable for certain item types.

## Success Criteria

The project is successful if a technically proficient user can:

- Select one or more Canva teams.
- Run a dry-run scan.
- Copy selected owned designs to a chosen destination.
- Obtain per-item verification status.
- Trash originals only after verified copy.
- Leave a team safely when eligible.[cite:1][cite:4]
- Export a full audit log of the run.

## Final Developer Notes

This extension should be built as a cautious human-in-the-loop operations tool, not as an unsupervised bot. Reliability, auditability, and damage prevention are more important than raw throughput.

The implementation should assume Canva’s UI will evolve. Therefore, selector isolation, recoverable execution, clear logs, and manual-assist fallbacks are first-class requirements rather than secondary polish items.
