# Minimal dashboard and scheduling requirements

## Scope and implementation timing

Outcome recording and redacted status are implemented in Phase 2. Build the minimal local dashboard during Phase 4 together with scheduling. This keeps four phases and ensures run history exists before the UI is built. The dashboard and revised trigger are not implemented yet.

## Schedule behavior

- Start the workflow at Windows sign-in, when the interactive user session is available, rather than at machine boot before login.
- Attempt the first cycle as soon as the user session and network are ready. Then attempt a new cycle one hour after the previous new-cycle attempt, repeating while awake and signed in.
- Maintain at least 60 minutes between new cycles across restarts or repeated sign-ins. If the previous attempt was recent, wait for its remaining interval rather than submitting immediately.
- Pending recovery takes priority only within the shared two-attempt hourly budget. It restores only; it never bypasses exhausted budget. Follow [retry policy](RETRY-POLICY.md).
- Do not wake the laptop. Do not replay missed hours. On resume, recover pending work first; otherwise attempt one cycle if due, and schedule the next one an hour later.
- On a transient failure, allow one retry after 60 seconds. A second failure ends activity until the next hourly window. Manual recovery uses the same budget; no hidden retries are permitted.
- Signing out, shutting down or sleeping stops execution. Sign-in/resume integration and scheduling mechanism will be validated in Phase 4; the original install-task script does not yet implement these requirements.
- UI explains the next eligible attempt as an estimate: Windows availability, sleep, network and authentication can delay it. Never claim exact execution while offline or asleep.

## Dashboard

A single minimal local dashboard opened on demand in the user's browser. It does not need to stay open for the scheduler to work. No cloud account, charts, external assets or database. The user's requested On/Off control supersedes the original read-only-report design; implement local write control in Phase 4 with a loopback-only interface and request validation, not an unauthenticated public endpoint.

The workflow defaults Off. Turning On permits eligible attempts only after setup/permission validation; it never resets budget. Turning Off blocks new attempts and cancels a waiting retry. An already-submitted cycle may finish restoring the original Name within its currently reserved attempt; Off must not initiate another recovery attempt. Show pending restoration if the cycle cannot finish. Manual save/recover commands must honor Off too. Explain that the page need not remain open after changing the control.

Display:

1. Current scheduler status (enabled, paused or not installed), pending recovery and last-known outcome. Scheduler state must come from Windows, not be inferred from the last successful run. If unavailable, show unknown.
2. Completed updates today and all time. One completed update means both saves in a fresh cycle were confirmed and the exact original Name was verified restored. Two saves count as one update.
3. Failed attempts today and all time; pending recovery is highlighted separately.
4. Last completed update and next eligible attempt; no countdown claiming guaranteed execution.
5. Recent activity table: local time, action (new cycle or recovery), result and a concise non-sensitive explanation.
6. Attempt number (1/2 or 2/2), pending retry or exhausted budget, and the next eligible window. An initial success does not schedule a second attempt.

Use Asia/Calcutta local dates for daily totals and UTC timestamps for storage. Avoid exposing Name values, session cookies, screenshots or raw exception messages.

## Outcome definitions and storage

Add a private append-only local history journal; no database or network API is needed. Each record has schema version, event ID, cycle ID where applicable, UTC timestamp, action, phase and a fixed outcome/reason code. Derive metrics from records, never from resettable in-memory counters or only state.json. Preserve durable cycle milestones so lost confirmation or a restart cannot fabricate a completed update.

- `cycle-completed`: a newly started cycle with verified temporary save and verified restoration. Count once by cycle ID, including when final restoration finishes in recovery and prior temporary verification was durably recorded.
- `cycle-failed`: a new-cycle attempt stopped, including navigation/login failure before journal creation. Count once by attempt ID; it may later be restored.
- `recovery-restored`: original Name verified after unfinished work. Show separately. Do not count as a completed update unless recorded milestones establish a verified temporary save in that cycle.
- `recovery-failed`: restoration remains unresolved. Keep distinct from new-cycle failures.
- `skipped`: cooldown or overlapping execution. Show if useful, never count as an update or failure.

Historical failure counts remain even after successful recovery. Repeated recovery invocations are separate activities linked to the original cycle. Persist completion before clearing the pending journal; deduplicate by stable event/cycle identifiers after crashes. A `restored` phase alone does not prove a completed update: a first save may never have happened.

Use a minimal loopback dashboard in Phase 4 to support the explicit On/Off control. Validate write requests and restrict host/origin; do not expose a public port. Escape rendered content. The runner remains independent of the dashboard process and checks the persisted activation flag before every attempt/retry. Dashboard status must distinguish workflow activation from Windows task installation/enabled state. Phase 2 provides history and status but does not yet provide this UI.

## Acceptance

- Two saves create one completed-update count, and a restart does not duplicate it.
- Failed submission with original name unchanged contributes failure/recovery activity, not a completed update.
- A verified temporary save followed by recovery restoration can finish the original cycle once.
- Dashboard opens without internet and works when no browser automation is active.
- Midnight daily totals use the selected timezone; timestamps remain unambiguous.
- Missing history shows zero/no history; corrupted records are reported, not silently counted as success.
- Sign-in, sleep/resume, cooldown, shutdown/restart and scheduler pause are exercised during Phase 4 validation.
