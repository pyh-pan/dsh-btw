# Acceptance record

This document separates implementation tests, actual Host execution, and GUI verification. Do not infer visual acceptance from successful installation or slot registration.

## Target

- Serving DSH: 0.2.1-rc.2.
- Profile: the user-selected Desktop profile.
- Installation: linked project directory through the DSH plugin manager; no manual profile or official installation edits.
- GitHub repository synchronization is user-authorized. No npm publication or user credentials are included.

## Automated source/contract tests

Final development build: **58 tests total; 57 passed, 0 failed, 1 explicitly skipped**. Source/bootstrap syntax checks, distribution build, package-content verification and SVG structure validation also passed. Installed version: `0.1.0-dev.4`.

The test suite covers independent tab creation from guide and slash submission, snapshot-at-create, multiple parent identities, duplicate native records, docking, retained collapse, creation/send idempotency, early and late close, reordered HTTP requests, cleanup failure/retry, restore without expired-tab recreation, input draft preservation, SSE revisions, safe Markdown, streaming frame assembly, capability masks, and transport admission.

A separate real-native test is explicitly skipped in an ordinary Node process unless a serving/unpacked compatible runtime is supplied. It must not be reported as passing merely because the skipped test appears in totals.

## Real Host checks performed during development

- First native create exposed an undeclared Cordis dependency. Fixed with an explicit private injection scope; subsequent real creation succeeded.
- Two side conversations were created from the running main Agent. Their captured event watermarks differed, proving they were not reusing the same fork.
- A side conversation called the currently selected model and produced the requested acceptance marker.
- A second turn recalled that side conversation's own marker, confirming multi-turn history.
- Both development side conversations were explicitly closed. A later read of a closed side returned an expired/closed failure.
- A real filesystem attempt initially exposed a global checkpoint wrapper trying to flush the private Session. The version-locked private tool dispatcher fixed this without modifying the original registry, restrictions, or guards. A subsequent real `read` successfully returned the project's package name.
- A later turn recalled the side's own marker and returned UNKNOWN for a new main-chat marker added after the side snapshot, confirming frozen-history behavior in actual model execution.

- Stop was exercised against an accepted, running side turn; the side returned to idle without resuming the main task.
- Explicit close was exercised immediately after a new generation request. Close completed, a subsequent state read returned expired/closed, and the runtime's side list was empty.

## Environment note

Unrelated optional-plugin import/configuration failures occurred in the development profile. They were handled separately with the user's permission and are not runtime requirements or source changes in this project.

## GUI verification status

The Client code was checked against the serving application's live Slot contracts; the Host plugin and its tool were loaded and exercised. Browser automation was unavailable in this environment. No screenshot or direct click acceptance has been completed. No fallback browser, personal profile, credentials, or replacement server was used.

By the user's latest instruction, browser/click/visual acceptance is no longer a completion gate for this implementation. The following remain a manual-use checklist, not checks claimed as completed:

1. Fourth native guide entry follows the existing three entries with matching default host styling.
2. Bare `/btw`, `/btw question`, and guide click each create a new tab.
3. Multiple side tabs stream independently and preserve drafts and history on collapse/tab/main-session changes.
4. Explicit tab close cancels and clears only that side, including during initialization or streaming.
5. Refresh reconnects to unclosed sides in the same Host; restart leaves old tabs expired.
6. Light/dark, narrow width, focus, keyboard/IME, error/cleanup notice, metadata and original icon.
