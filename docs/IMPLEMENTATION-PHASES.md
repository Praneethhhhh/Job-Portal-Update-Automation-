# Implementation checkpoints

## Phase 1 — cycle state and recovery (implemented)

`src/cycle.js` provides the two-save cycle coordinator with a browser-independent adapter, exact original/temporary names, persisted write intent, conservative recovery, recover-only operation, hourly attempt reservation and a shared exclusive lock. JSON writes flush file contents before replacement. This improves process-crash recovery; it does not make remote saves atomic or guarantee recovery from storage hardware failure.

`npm run status` reports pending recovery and phase without exposing the journaled names. The journal is private local state, not an event log; Windows permissions are inherited and file mode alone is not a Windows access-control guarantee.

Tests use a simulated persisted profile to inject interruptions before and after both submissions. They cover name punctuation/Unicode/whitespace, conflicting edits, lost confirmations, challenges, malformed journals, lock contention and cooldown. They establish coordinator behavior, not actual browser correctness.

The adapter must implement `readName()` by reopening and validating the actual editor, and `saveName(expected, next)` by checking the expected persisted Name, preserving other fields and requiring fresh confirmation. All external writes belong to that adapter. It must not log names. The coordinator never persists upstream exception text; callers should log only its generic error message, not its cause.

Phase 2 supersedes Phase 1's recovery cooldown exemption: restoration now shares the strict two-attempt hourly budget. Local `success` means original Name verified; completed-update totals additionally require durable temporary verification. Scheduler remains inactive.

## Phase 2 — browser workflow (implemented locally)

Implemented [two-attempt hourly policy](RETRY-POLICY.md): one eligible retry only, a persisted budget across restarts, and recovery subject to the same cap. CLI waits until the reserved retry time; normal invocations and manual recover share the budget. No scheduler restart-on-failure is used.

Implemented flushed JSONL outcome history, deduplicated completion IDs, IST daily totals, failed-attempt totals and budget/status output. Crashed reservations consume a slot; subsequent invocations repair missing interruption records. See [dashboard and scheduling requirements](DASHBOARD-AND-SCHEDULING.md).

Replaced the old save path with the coordinator and a lazy browser adapter. Added `recover`, Basic details heading verification, explicit Name targeting, other-field snapshot comparison, fresh confirmations and reopened persisted-value checks. Local browser tests cover same-URL wrong dialogs, full restoration, other-field changes, CAPTCHA, lost confirmation and validation rejection. Chrome and Edge are configurable; neither live Naukri compatibility nor selectors are verified yet.

Source is stored in local Git on main. `.local`, `config.local.json` and dependencies are ignored. GitHub publishing awaits the user's instruction. Each additional Windows computer needs installation, its own manual login and local selector/config verification; never copy logged-in sessions through GitHub.

## Phase 3 — supervised Naukri validation (tooling implemented; live checks pending)

Establish site permission, manually authenticate, inspect actual controls, test dry-run and one complete live cycle. Verify original Name restoration and background execution. No local test establishes Naukri permission or compatibility.

`npm run check-setup` now diagnoses setup and local state offline without exposing private values. `npm run verify` and `npm run verify -- --background` record visible and headless read-only checks. `npm run verify-save` requires both checks for the current configuration and explicit activation/permission, then executes one visible supervised attempt under the normal budget. It never launches an automatic retry. Redacted evidence is stored in `.local/validation.json`; recovery alone cannot certify a fresh cycle. See [supervised validation](SUPERVISED-VALIDATION.md). These commands do not activate scheduling or establish permission automatically.

## Phase 4 — scheduling and operation (implemented locally; Windows pilot pending)

Implemented the loopback dashboard, protected persisted On/Off control, redacted history/counts, recovery/budget display and Windows task-state probing. The independent worker checks eligibility every 15 seconds using the existing coordinator, shared budget and a separate runner lock. Sign-in/unlock/resume triggers plus an IgnoreNew watchdog start the hidden interactive-user worker without waking the machine or replaying missed hours. Pause/remove are graceful between reserved attempts. Activation and installation require current recorded Phase 3 evidence, site permission and manual `unattendedConfirmed`; installation can remain Off.

Local tests cover request protection, privacy, On/Off persistence, cooldowns, one delayed retry, exhausted budget, recovery priority, lock contention, long sleep gaps, pause gating and browser rendering at desktop/mobile sizes. Windows accepted the generated task XML in preview mode without registration. Actual sign-in, sleep/resume, shutdown, pause/resume and a ten-hour pilot remain manual release checks. See [operation](OPERATION.md) and [dashboard and scheduling requirements](DASHBOARD-AND-SCHEDULING.md).
