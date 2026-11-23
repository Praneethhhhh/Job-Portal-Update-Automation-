# Revised Basic details workflow

## Status and precedence

Requested revision based on the user's two screenshots and navigation links. This document supersedes unchanged-save requirements in the original architecture and interfaces wherever they conflict. Phase 2 now implements the workflow and strict shared retry budget with local mock browser tests. Live Naukri selectors and behavior are unverified. Scheduling remains inactive.

## Navigation and editor identity

Observed addresses:

- `https://www.naukri.com/mnjuser/profile?id=&altresid`
- `https://www.naukri.com/mnjuser/profile?id=&altresid&action=modalOpen`

Both screenshots show the modalOpen address, but one dialog is Basic details and the other is Resume headline. Never use that query parameter as proof that the correct editor is open. Navigate to the profile, locate the edit control within the top profile identity card, and verify the resulting dialog by the exact Basic details heading and its Name field. If a different dialog is open, close it using its scoped close control before opening the intended editor. Never use a generic first pencil or global Save button.

Screenshots establish visual requirements, not DOM selectors. Actual accessible labels and DOM structure still require inspection in the authenticated dedicated browser. Do not guess selectors from the images.

## Hourly cycle

1. Acquire the exclusive lock, enforce the durable two-attempt hourly budget, and inspect pending recovery before starting any new cycle. See [retry policy](RETRY-POLICY.md).
2. Navigate to the profile and verify the Basic details dialog. Detect login or security challenges and stop for manual attention.
3. Read the exact current Name as `originalName`; require a nonempty supported input. Compute `temporaryName = originalName + '.'`. Preserve original whitespace and punctuation; restoration must never use trim or a generic remove-last-dot operation.
4. Snapshot all other editable values. Before any mutation, atomically persist a private recovery journal containing the original, temporary value, cycle ID and phase.
5. Fill only Name with the temporary value. Recheck all other values, editor identity and challenge status. Record submit intent before clicking the dialog-scoped Save exactly once.
6. Wait at least five seconds after Save, then reopen Basic details to verify Name equals the temporary value. A toast alone is insufficient. Default `toast-and-editor` mode also requires the configured fresh toast. The live site's optional `persisted-editor` mode requires modal closure and a fresh navigation showing the exact requested value, without relying on a second toast.
7. Restore the journaled original Name, preserving every other field. Record restore intent, save once, wait at least five seconds, and reopen Basic details to verify exact restoration.
8. Mark the cycle complete and clear the pending journal only after verified restoration. Close the browser and release the lock. Event logs include phases and outcomes, never the Name values.

The two saves are one hourly cycle. Do not wait an hour between them. If the original already ends in a period, append exactly one additional period and restore the original exactly; never infer a baseline by stripping punctuation. If validation rejects the temporary value, stop and reconcile current state without attempting other spelling changes.

## Recovery state machine

Phases: `prepared`, `temporary-submit-intent`, `temporary-verified`, `restore-submit-intent`, `restored`. Persist intent before each external write because the browser can stop after the server accepts a save but before the app receives confirmation.

For an unfinished cycle, reopen the verified dialog and compare current Name:

| Observed value | Action |
|---|---|
| Exact original | Mark restored; end this invocation without starting another cycle |
| Exact temporary | Restore original and verify; do not perform another temporary edit |
| Anything else | Stop and request manual reconciliation; never overwrite a possible user edit |
| Login/CAPTCHA or unavailable site | Retain journal, stop and report unresolved restoration |

Restoration gets priority when a budget slot is available, but cannot bypass the two-attempt hourly limit or security challenges. After an ambiguous result, the single eligible retry must reopen and reconcile before any submission. After two failures, preserve the journal and defer until the next window. A crash, network outage or shutdown can leave the temporary name visible until recovery succeeds; no implementation can make the two remote saves atomic.

## Data and interface changes

No database or HTTP API is needed. Add `.local/pending-cycle.json` as a private atomic journal. Keep the original Name out of general status output, errors and event logs. Include phase and `restorationRequired` in public local status. Extend config with verified Name and Basic details heading locators; Save remains scoped to that dialog. Add `recover` CLI command for restoration-only execution under the same lock. Scheduler entry remains a single hourly invocation; no overlapping recovery task.

`dry-run` must not persist a temporary name remotely. It validates editor identity and computes the proposed change privately. A disabled Save before editing is no longer a dry-run failure: it may become enabled only after Name changes.

## Implementation order and validation

1. Add and test pure value generation, journal phases and recovery decisions.
2. Replace generic editor flow with verified Basic details targeting and other-field comparison.
3. Implement both submissions, fresh confirmation handling and reopen verification.
4. Test with a local mock page where Basic details and Resume headline share the same URL. Confirm the wrong editor is never submitted.
5. Inject failure before and after each submission, including server acceptance followed by lost confirmation. Verify recovery restores only when the value is original or temporary; conflicting edits must stop.
6. Verify original names with existing punctuation, field validation rejection, delayed success, expired login, lock contention and cooldown behavior.
7. After site permission and actual selectors are established, run a supervised live cycle, confirm exact restoration, and only then activate scheduling.

Automation permission and increased recruiter visibility remain unverified. This two-edit workflow changes the requested site activity and must be included when confirming permission.
