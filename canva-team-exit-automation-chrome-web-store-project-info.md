# Canva Team Exit Automation — Chrome Web Store Project Information

## Document Purpose

This document is a publication-ready project information pack for the Chrome Web Store listing, review submission, compliance preparation, support pages, and internal release coordination. It is written for a Chrome extension that helps a user migrate their own Canva designs out of team workspaces, optionally trash originals after verified copy, and then leave the team through Canva’s existing user interface.[cite:1]

The extension’s purpose must remain narrowly scoped. Chrome Web Store policy requires extensions to have a single purpose, and permissions must be tied to that purpose.[cite:24] This project should therefore be presented as a focused Canva workspace exit and design migration assistant, not as a general Canva automation suite.[cite:24]

## Product Identity

### Proposed extension name options

Pick one final name and keep it consistent across listing assets, support pages, and privacy documentation.

- Canva Team Exit Automation
- Canva Design Migration Assistant
- Canva Workspace Exit Helper
- Canva Team Transfer Assistant

Recommended primary name:

**Canva Team Exit Automation**

Rationale: it clearly communicates the single purpose of helping users copy their designs, clean up originals, and exit teams, which aligns better with Chrome Web Store single-purpose expectations.[cite:24]

### Category recommendation

Recommended Chrome Web Store category: **Productivity**.

This extension automates repetitive operational steps for a user already working in Canva, which fits a productivity workflow better than a general utilities or developer classification.[cite:24]

### Target audience

- Freelancers leaving client Canva teams.
- Employees moving work out of temporary shared teams where policy permits.
- Students or creators exiting school or collaborative teams.
- Power users managing many Canva team memberships.

## Single Purpose Statement

The extension’s single purpose is to help a logged-in Canva user safely migrate selected designs they own from a Canva team to another destination workspace available to them, verify each copy, optionally move originals to trash, and then guide the user through leaving the source team when eligible.[cite:1][cite:24]

This statement should be reused consistently in the detailed description, privacy policy, onboarding disclosure, review notes, and support site. Doing so reduces ambiguity and helps justify requested permissions under Chrome Web Store policy.[cite:18][cite:24]

## Store Listing Copy

### Extension name

Canva Team Exit Automation

### Short description

Safely copy your Canva designs out of team workspaces, verify each transfer, trash originals, and leave teams with audit logs.

This should fit Chrome Web Store short description limits if kept concise, since listing guidance commonly caps the short description at 132 characters.[cite:30]

### Detailed description

Use the following as the main Chrome Web Store detailed description draft:

> Canva Team Exit Automation helps a logged-in Canva user move their own designs out of team workspaces with a safer, review-first workflow. The extension scans a selected Canva team, finds candidate designs, copies them to a destination workspace available to the user, verifies the copy result, optionally moves originals to trash, and then helps the user leave the team when Canva permits it.[cite:1][cite:4]
>
> The extension is designed for people who belong to many Canva teams and want to reduce repetitive manual work without giving up control. It uses Canva’s visible web interface and the user’s existing session, instead of relying on undocumented transfer APIs. Because Canva documents copying as a one-item-at-a-time workflow, the extension processes designs sequentially and shows detailed progress throughout the run.[cite:1]
>
> Key features include:
>
> - Team discovery for Canva workspaces available in the current session.
> - Dry-run scanning before any change is made.
> - Copy workflow with verification before any destructive action.
> - Optional trashing of originals only after successful copy verification.
> - Team-leave assistance after migration is complete and the user confirms the action.[cite:4]
> - Pause, resume, retry, skip, and run logging.
> - Local audit logs exportable for troubleshooting and recordkeeping.
>
> Safety is a core design principle. The extension follows a copy-first, verify-second, trash-third, leave-last workflow, so users can review what will happen before anything changes. If a team admin blocks leaving the team, the extension reports that state and does not force the action.[cite:4]
>
> This extension is intended for supported Canva workflows only. Availability of copy, trash, and leave actions depends on the Canva interface, the user’s permissions, and team policies.[cite:1][cite:4]

## Key Features for Listing

Use these bullet points for the Chrome Web Store highlights section, website landing page, or promo image copy.

- Scan Canva teams available in the current browser session.
- Review candidate designs before any action starts.
- Run a dry-run mode with no mutations.
- Copy selected designs to a destination workspace using Canva’s UI workflow.[cite:1]
- Verify copies before allowing originals to be trashed.
- Trash originals only after successful verification.
- Leave eligible teams through Canva’s own settings flow.[cite:4]
- Pause, resume, retry, skip, and export run logs.

## Core Benefits

### User benefits

- Saves time when leaving many Canva teams.
- Reduces manual clicking and repetitive navigation.
- Adds safeguards around destructive actions.
- Produces an audit trail for each migration run.
- Helps prevent loss of access by enforcing a copy-before-leave workflow.[cite:4]

### Reviewer-facing benefits

- Clear single-purpose utility tied to Canva team exit workflow.[cite:24]
- Limited scope and limited permissions rationale.[cite:24]
- Local-first handling of operational data.
- Strong user control with explicit confirmations and review steps.

## Permission Justification Draft

Chrome Web Store review often focuses on whether requested permissions are necessary for the extension’s single purpose.[cite:24] Use the narrowest set possible, and explain each permission in reviewer notes.

| Permission | Why it is needed | Reviewer justification |
|---|---|---|
| `storage` | Save settings, job state, logs, and export preferences locally. | Needed to preserve user configuration and run state between popup sessions. |
| `activeTab` | Interact with the current Canva tab after the user explicitly opens Canva and starts the workflow. | Limits interaction to the user’s active Canva tab and supports safer user-driven automation. [cite:29] |
| `scripting` | Inject or coordinate content scripts required for DOM discovery and automation. | Required to inspect the Canva interface and run step-by-step automation only on Canva pages. |
| Canva host permissions | Enable content scripts on Canva domains used by the web app. | Necessary because the extension automates Canva’s visible UI to perform its single disclosed purpose. [cite:24] |

Do not request unrelated permissions such as tabs history, downloads, clipboard, or broad all-sites access unless a concrete and reviewable need is later established.[cite:24]

## Privacy and Data Handling Positioning

Chrome Web Store policy requires accurate privacy disclosures for products that handle user data, including disclosure of what is collected, how it is used, and who it is shared with.[cite:17][cite:18][cite:19] If the extension handles any user data, a privacy policy must be linked in the Chrome Web Store Developer Dashboard.[cite:17][cite:18][cite:19]

### Recommended privacy posture

Position the extension as **local-first**:

- Process Canva page information locally in the browser.
- Store settings, migration state, and logs locally using extension storage.
- Do not transmit design metadata, content, titles, or logs to external servers by default.
- Offer export only when the user explicitly requests it.
- Avoid analytics in v1.

### Recommended data disclosure stance

Assuming the extension stores only operational metadata locally and does not send it to a backend by default, the disclosure should be narrow and specific.

Potential categories that may need to be disclosed in the dashboard, depending on final implementation:

- User activity, if Chrome interprets the extension’s interaction with Canva pages and workflow events under that category.[cite:21][cite:26]
- Website content, if the extension reads Canva page content such as design titles or item lists to perform the migration workflow.[cite:26]

The final disclosure must exactly match the implementation. Chrome policy also requires prominent in-product disclosure and consent where required, not just a privacy policy link.[cite:17][cite:18][cite:23]

## In-Product Disclosure Draft

If the implementation reads Canva page content, design titles, ownership labels, or workflow metadata to operate, show an onboarding disclosure before first live execution.

Suggested disclosure text:

> Canva Team Exit Automation reads visible Canva workspace information in the current tab, such as team names, design titles, item status, and action availability, so it can scan your selected team, copy selected designs, verify results, optionally move originals to trash, and assist with leaving the team. Data is processed locally in your browser unless you explicitly export logs.

Suggested consent action:

- Checkbox: “I understand and agree to this local data handling for the migration workflow.”
- Button: “Continue”

This aligns with Chrome guidance that prominent disclosures and explicit consent must occur within the product UI when required, rather than only in the Web Store listing or privacy policy.[cite:17][cite:23]

## Privacy Policy Content Requirements

The privacy policy linked in the store dashboard should at minimum disclose:

- What information the extension accesses or collects.
- Whether data stays local or is transmitted externally.
- How logs are stored and for how long.
- Whether data is shared with any third parties.
- Contact details for privacy questions.

Chrome’s policy states that privacy policies must accurately and comprehensively disclose how user data is collected, used, and shared, and must be accessible through the designated dashboard field.[cite:18][cite:19]

### Recommended privacy policy summary text

> Canva Team Exit Automation processes Canva page information that is necessary to scan selected workspaces, identify candidate items, execute user-requested copy and cleanup actions, and maintain local run logs. By default, data is processed locally in the browser and is not transmitted to external servers unless the user explicitly exports or submits diagnostic information. The extension does not sell user data and does not use collected information for advertising.

## Chrome Web Store Assets Checklist

Chrome Web Store listings require standard visual and descriptive assets. Practical listing guidance commonly includes a required 128×128 store icon and at least one screenshot, with screenshots usually expected at either 1280×800 or 640×400 pixels.[cite:30][cite:31]

### Required assets

- Store icon: 128×128 PNG.[cite:30][cite:31]
- At least 1 screenshot, up to the platform maximum allowed, showing real extension UI and workflow.[cite:30][cite:31]
- Privacy policy URL if the final implementation handles user data.[cite:17][cite:18][cite:19]

### Recommended optional assets

- Small promo image: 440×280.[cite:30]
- Large promo image: 920×680.[cite:30]
- Marquee promo image: 1400×560, if desired and supported by current listing surfaces.[cite:30]
- Support website or landing page.
- Short demo video link.

## Screenshot Plan

Use screenshots that make the single purpose obvious and that show the extension working on Canva, not generic UI mockups.

Recommended screenshot set:

1. Popup home screen showing team detection and destination selection.
2. Dry-run results screen listing candidate designs and risk flags.
3. Live migration screen showing progress, current action, and safety status.
4. Review/confirmation screen before trash or leave-team action.
5. End-of-run summary with copied, verified, trashed, skipped, and blocked counts.

Screenshot principles:

- Use real but sanitized Canva data.
- Keep wording readable at store thumbnail sizes.
- Emphasize safety, verification, and user control.
- Avoid implying unsupported bulk server-side transfer.

## Promotional Messaging Angles

### Safe automation angle

Copy your Canva designs out of shared teams with verification before cleanup.

### Time-saving angle

Reduce repetitive clicks when leaving many Canva teams.

### Control angle

Dry-run first, review every step, then copy, trash, and leave with confidence.

## Reviewer Notes Draft

Use a reviewer note that explains why the extension needs Canva access and how the workflow stays narrow.

Suggested reviewer note:

> This extension has a single purpose: helping a logged-in Canva user migrate selected designs they own from a Canva team to another destination workspace available to them, verify the copy result, optionally move originals to trash, and guide the user through leaving the source team. The extension works only on Canva pages, uses the user’s active session and visible UI, and stores operational state locally using extension storage. It does not provide unrelated browsing functionality. Requested permissions are limited to the minimum needed to detect Canva workspaces, inspect visible item lists, execute the user-requested workflow on Canva pages, and preserve local run state.[cite:24][cite:29]

## Support Page Content

A public support page is strongly recommended, even when not strictly required, because it improves review clarity and user trust.

Recommended sections:

- What the extension does.
- What it does not do.
- Supported Canva workflow assumptions.
- Permissions explanation.
- Privacy summary.
- Troubleshooting common failures.
- Contact email.
- Version and release notes.

## FAQ Draft

### What does this extension do?

It helps a logged-in Canva user scan a selected team, copy selected designs to another destination workspace, verify results, optionally move originals to trash, and then leave the team when eligible.[cite:1][cite:4]

### Does it use Canva’s private API?

No. The product should be positioned as a browser automation assistant built on Canva’s visible web interface and the user’s existing session.[cite:1]

### Can it transfer everything in one click?

No. Canva documents copying between teams as a one-item-at-a-time workflow, so the extension processes items sequentially and shows progress during the run.[cite:1]

### Will it leave a team automatically?

Only after the user confirms and only when Canva makes the leave action available for that team. Canva documents that leave access can depend on admin controls.[cite:4]

### Does it upload my Canva data to a server?

The intended v1 posture is local-first processing and local storage of operational metadata unless the user explicitly exports logs.

## Compliance Notes

### User data compliance

Chrome requires accurate privacy disclosures, and products handling user data must post an up-to-date privacy policy and handle data securely.[cite:17][cite:18][cite:19] Chrome has also emphasized that disclosures in the store listing alone are not enough where prominent in-product disclosure and consent are required.[cite:17][cite:23]

### Single purpose compliance

The extension’s messaging, permissions, and functionality must stay tightly aligned around Canva team exit automation. Chrome’s quality guidelines state that excessive permissions unrelated to the extension’s single purpose can create policy issues.[cite:24]

### Future policy caution

Chrome announced additional privacy policy updates in 2026 emphasizing that collected user data must be strictly necessary to the extension’s disclosed single purpose and that all data collection must be prominently disclosed.[cite:22] This makes it even more important to keep the extension local-first and avoid unnecessary telemetry.[cite:22]

## Release Readiness Checklist

Before publishing, confirm the following:

- Final extension name selected and consistent.
- Short description finalized.
- Detailed description finalized.
- Store icon prepared.
- Screenshots prepared with real UI.
- Privacy policy published at a public URL if required.[cite:17][cite:18][cite:19]
- Data disclosure form accurately completed in the developer dashboard.[cite:21]
- Reviewer notes added.
- Permissions minimized and justified.[cite:24]
- Onboarding disclosure implemented if required.[cite:17][cite:23]
- Support page published.
- Contact email available.

## Metadata Summary

| Field | Recommended value |
|---|---|
| Extension name | Canva Team Exit Automation |
| Category | Productivity |
| Primary purpose | Help users migrate their Canva designs out of team workspaces and leave teams safely |
| Short description | Safely copy your Canva designs out of team workspaces, verify each transfer, trash originals, and leave teams with audit logs. |
| Core differentiator | Review-first Canva team exit workflow with copy verification and local audit logs |
| Privacy posture | Local-first processing, no external transmission by default |
| Permissions theme | Minimal Canva-only operational permissions |

## Final Positioning Summary

The strongest publication strategy is to position the extension as a narrowly scoped Canva team exit assistant with local-first data handling, explicit user control, and strong safety checks. That framing aligns the product description, permissions, and privacy posture with Chrome Web Store expectations around single purpose, transparency, and data minimization.[cite:17][cite:18][cite:22][cite:24]
