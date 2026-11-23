# Phase 4 operation

## Local dashboard

Run `npm run dashboard` and open `http://127.0.0.1:4317`. Keep that terminal running while using the page. The page works offline, uses no external assets and polls local status every 15 seconds. Its counts come from durable history, with daily boundaries in Asia/Calcutta. Completed updates, failed attempts and pending restoration remain separate. Corrupt state shows unavailable counts instead of fabricated zeros. Task status comes from Windows; read/probe failures show unknown.

On requires valid configuration, explicit site permission, a passing read-only check, and a successful supervised cycle in the selected browser mode. The dashboard and scheduler share a lock while saving the switch or reserving a new attempt. After Off is saved, only an attempt already reserved can finish. The toggle preserves the budget and history. Install the Windows tasks separately.

Account connection, read-only checks and supervised validation are displayed separately. A saved Chrome directory is shown as a saved session, not as proof that authentication never expires. After all validation gates pass, the dashboard offers an explicit unattended-operation checkbox; checking it and turning On persists the owner's confirmation through the same protected local control request. It cannot bypass missing validation or permission.

`postSaveDelayMs` enforces a minimum five-second pause after each submission before reopening. Both the temporary and restore saves are paced. In `persisted-editor` confirmation mode a fresh server read must match the requested Name; its result is reused once by the coordinator to avoid a duplicate immediate navigation. No randomization, anti-detection spoofing or security bypass is provided, and a delay does not establish site permission.

The local HTTP server binds only to 127.0.0.1 and validates Host, Origin, request size, JSON shape and a random CSRF token. It rejects cross-site browser requests and serves only three fixed assets plus two API routes. Status maps known fields/outcomes instead of exposing journal values, config, raw errors or arbitrary history fields. This protects the local web interface; it does not protect against malware already running under your Windows account.

## Independent runner and Windows task

For an explicitly requested short live test, `npm run test-minute` runs at most two visible cycles, waiting 60 seconds after the first verified completion before starting the second. The five-second post-save pauses remain enforced. The normal configuration and hourly budget are not rewritten. A separate persisted minute-test session/budget expires after five minutes, cannot reserve a third cycle, and stops on the first failure. The normal workflow must remain Off. Normal invocations cannot overlap the active test, and after testing they enforce a full normal interval from the latest test attempt before starting another cycle. The test history is labeled separately; pending restoration is retained on failure. This temporary mode is not an unattended one-minute schedule.

`npm run scheduler` runs a foreground worker for operational testing. `scripts/install-task.ps1` installs a hidden interactive-user worker after the same validation gates, and can install while workflow activation is Off. `-Preview` emits the task XML without registering a task or requiring completed live validation. `-Pause` disables the Windows task; `-Resume` revalidates setup, enables and starts it; `-Remove` disables and removes it. Existing data/session files are retained.

The generated tasks use sign-in and wake signals, with an unlock trigger and five-minute backup timer for starting the worker. Windows ignores overlapping worker launches and leaves the laptop asleep. Before registering the tasks, run `scripts\protect-project.ps1` to restrict the checkout and inherited browser-profile permissions to the owner, SYSTEM and administrators.

The worker checks task state and saved eligibility about every 15 seconds. A fresh sign-in or wake can start one cycle after a completed cycle. Subsequent scheduled cycles use a delay chosen uniformly from 35 to 45 minutes at whole-second precision, saved at reservation so polling and restarting the worker preserve the selected deadline. Pending recovery takes priority and the single retry waits at least 60 seconds after a recorded transient failure. The browser closes before the workflow lock is released.

Managed workers block new reservations if Windows task status is unknown and exit after seeing paused or removed state. A new invocation reclaims a lock when the operating system confirms its owner PID is gone. Locks with unreadable ownership or a PID still in use require inspection. The dashboard identifies an enabled task whose runner is stopped. After a minute test, the cooldown blocks new updates while pending restoration can proceed under the regular attempt budget.

## Manual release checks still required

- Finish the actual-account Phase 3 guide, including other-field preservation, background live execution and interrupted-save recovery. Set unattended confirmation only after these checks.
- Preview and install the task while Off. Confirm its account, triggers, action, no-wake/no-catch-up settings and actual status in Windows.
- Turn On for a supervised eligible attempt. Close the dashboard and verify the independent worker continues and records one completed update.
- Reopen the dashboard; test Off during a retry wait, task pause/resume and removal. Verify no new reservations, no budget reset and graceful restoration of any active cycle.
- Exercise overlapping triggers, sign-out/sign-in, shutdown/restart and sleep across multiple hours. Confirm one eligible attempt after resume and no missed-hour replay.
- Review a ten-hour pilot for exact restoration, completed/failed counts, authentication challenges and daily totals. Local mock tests and task XML preview do not establish these results.
