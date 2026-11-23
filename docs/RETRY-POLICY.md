# Strict hourly retry policy

## Authority and implementation status

This requirement takes precedence over earlier no-retry language and recovery exemptions. The persisted budget, bounded CLI retry and local tests are now implemented in Phase 2. Live compatibility and unattended scheduling remain unverified; scheduling stays inactive until Phases 3–4.

## Budget and timing

The owner explicitly requested a temporary one-minute live test. `npm run test-minute` is a separate bounded mode: two visible cycles only, a 60-second wait after the first completed cycle, the existing five-second waits after Save, and no automatic retry. It uses a separate test budget and a five-minute session deadline, retains shared recovery/history/locking, and leaves the normal workflow Off. It does not rewrite the normal 60-minute budget. Normal activity is blocked during the test and for the configured normal interval after its last attempt. The rules below continue to govern ordinary scheduling and manual save/recovery commands.

- Each hourly window permits at most two workflow attempts: the initial attempt and one retry only if the first fails for a retryable reason. A successful initial attempt ends the window immediately.
- A window begins when its first attempt is reserved and lasts 60 elapsed minutes; it is not a wall-clock hour bucket. For example, an initial attempt at 10:20 and a retry at 10:21 permit no third attempt before 11:20.
- Wait 60 seconds **after the failure**, using a persisted `failedAt` timestamp, before the single retry. An attempt that runs for 90 seconds must still wait another 60 seconds. This is a local operational default, not a claim that Naukri approves this frequency. If the delay extends beyond the window, do not replay its retry; enter the next eligible window once, no sooner than the end of the failure delay. The hourly window remains anchored to the original attempt start.
- For interrupted processes or legacy failed records with unknown failure time, persist detection time as `failedAt` and wait 60 seconds from that point. Restarting again must not reset that timestamp.
- Both normal edits and restoration use the same budget. After the second failure, stop all workflow attempts for the remainder of that window, including recovery. Retain the journal and show unresolved restoration on the dashboard.
- A complete two-save sequence is one workflow attempt, not two attempts. The retry must reconcile the original attempt before deciding whether further writes are needed; it must not blindly repeat both saves.
- Persist the window start, attempt count, attempt IDs and next eligible time before browser interaction. Crashes consume the reserved attempt. Restarting the worker or running a manual command keeps the current budget. A new Windows sign-in or wake signal can open a fresh window once, including after retryable failures. Pending restoration takes priority. A sign-in or wake does not clear a manual-attention block.
- Use the exclusive lock around reservation and execution. Overlapping or budget-blocked invocations are skips, not additional failed attempts. Do not enable Task Scheduler automatic restart-on-failure or nested browser retries.

## Retry eligibility and reconciliation

Transient navigation or network failures, ambiguous submission confirmations, and a detected editor change before Save can use the one retry. If the app stopped before the first Save, it can start the cycle again in a fresh editor. If submission may have occurred, it must freshly observe the persisted Name first:

| Observed state | Retry behavior |
|---|---|
| No pending journal, first attempt failed before mutation | Start the same scheduled cycle within remaining budget |
| Original Name, no verified temporary change | End and reconcile the interrupted cycle without making another temporary change |
| Recorded temporary Name | Restore the exact original and verify; do not append another period |
| Original Name after restore | Finalize once, without another submission |
| Unexpected Name or corrupt journal | Stop for manual reconciliation; do not retry edits |

Login/OTP/CAPTCHA, access denial or rate limiting, profile validation rejection, wrong/ambiguous editor and missing permission/configuration stop immediately; they do not require using the second attempt. A rate-limit signal must not be bypassed with the generic retry delay. Security challenges require manual attention before later execution.

Restoration has priority over starting new updates when a budget slot is available, but it cannot exceed two attempts in the window. This means a temporary period can remain visible until the next window or manual correction on Naukri if both attempts fail. Do not promise immediate restoration after that limit.

## Dashboard and history

Show attempt `1/2` or `2/2`, retry pending, budget exhausted/waiting until a timestamp, and pending restoration. Store each failed attempt separately. Show completed updates separately from failed attempts: one cycle can contain a failed attempt and later finish successfully. Count completed cycles once by stable cycle ID; both saves together remain one update. Keep recovery activity identifiable and never include names in logs or dashboard output.

## Required tests

- First success: one attempt, no retry.
- Transient first failure then success: exactly two attempts.
- Two failures: no third read, navigation or save before the next window.
- Interrupted window survives restart, repeated sign-in, resume and manual commands.
- Ambiguous first save: retry observes current Name and restores rather than appending twice.
- Both recovery attempts fail: retain pending journal, stop and defer to next window.
- Security challenges and conflicts do not trigger automatic retries.
- Test 10:20/10:21 failures and a 11:00 trigger: blocked until 11:20.
- Budget exhaustion and subsequent successful recovery do not duplicate dashboard counts.
