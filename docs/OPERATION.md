# Phase 4 operation

## Local dashboard

Run `npm run dashboard` and open `http://127.0.0.1:4317`. Keep that terminal running while using the page. The page works offline, uses no external assets and polls local status every 15 seconds. Its counts come from durable history, with daily boundaries in Asia/Calcutta. Completed updates, failed attempts and pending restoration remain separate. Corrupt state shows unavailable counts instead of fabricated zeros. Task status comes from Windows; read/probe failures show unknown.

Recent Activity shows up to 20 records per page. Use **Next** and **Previous** to fetch another page, or **Refresh** to return to the newest records. The newest page refreshes when history changes, while older pages stay in place. The dashboard reads activity in chunks from the end of `.local/history.jsonl`, using a file offset to retrieve older records. Status polling fetches totals separately, streams the journal when totals need refreshing, and caches the counters while the file and local date stay unchanged.

The journal is an append-only local text file with one JSON event per line. It suits a single laptop at this update rate and is excluded from Git. The file grows as events accumulate. If it becomes large enough that scanning it or checking for duplicate events noticeably slows the app, a local SQLite database with indexes and a retention policy would be a better fit.

On requires valid configuration, explicit site permission, a passing read-only check, and a successful supervised cycle in the selected browser mode. The dashboard and scheduler share a lock while saving the switch or reserving a new attempt. After Off is saved, only an attempt already reserved can finish. The toggle preserves the budget and history. Install the Windows tasks separately.

The dashboard displays the saved browser session, read-only check, and supervised result separately. A saved Chrome directory can outlast the Naukri login. If the session expires, sign in again through the dedicated browser.

`postSaveDelayMs` enforces a minimum five-second pause after each submission before reopening. In `persisted-editor` mode, a fresh read must match the requested Name. The coordinator can reuse that verified value once to avoid a duplicate navigation. The app stops on authentication challenges and access denials.

The local HTTP server binds only to 127.0.0.1 and validates Host, Origin, request size, JSON shape and a random CSRF token for writes. It rejects cross-site browser requests. The status and activity endpoints return selected fields and redacted outcomes.

## Independent runner and Windows task

For an explicitly requested short live test, `npm run test-minute` runs at most two visible cycles, waiting 60 seconds after the first verified completion before starting the second. The five-second post-save pauses remain enforced. The normal configuration and hourly budget are not rewritten. A separate persisted minute-test session/budget expires after five minutes, cannot reserve a third cycle, and stops on the first failure. The normal workflow must remain Off. Normal invocations cannot overlap the active test, and after testing they enforce a full normal interval from the latest test attempt before starting another cycle. The test history is labeled separately; pending restoration is retained on failure. This temporary mode is not an unattended one-minute schedule.

`npm run scheduler` runs a foreground worker for operational testing. `scripts/install-task.ps1` installs a hidden interactive-user worker after the same validation gates, and can install while workflow activation is Off. `-Preview` emits the task XML without registering a task or requiring completed live validation. `-Pause` disables the Windows task; `-Resume` revalidates setup, enables and starts it; `-Remove` disables and removes it. Existing data/session files are retained.

The generated tasks use sign-in and wake signals, with an unlock trigger and five-minute backup timer for starting the worker. Windows ignores overlapping worker launches and leaves the laptop asleep. Before registering the tasks, run `scripts\protect-project.ps1` to restrict the checkout and inherited browser-profile permissions to the owner, SYSTEM and administrators.

The worker compares the current time against the saved deadline about every 15 seconds. It checks Windows Task Scheduler status about once a minute while waiting and again before reserving a new attempt. Chrome opens only for an eligible attempt. A fresh sign-in or wake can start one cycle after a completed cycle. Subsequent scheduled cycles use a delay chosen uniformly from 35 to 45 minutes at whole-second precision, saved at reservation so polling and restarting the worker preserve the selected deadline. Pending recovery takes priority and the single retry waits at least 60 seconds after a recorded transient failure. The browser closes before the workflow lock is released.

Managed workers block new reservations if Windows task status is unknown and exit after seeing paused or removed state. A new invocation reclaims a lock when the operating system confirms its owner PID is gone. Locks with unreadable ownership or a PID still in use require inspection. The dashboard identifies an enabled task whose runner is stopped. After a minute test, the cooldown blocks new updates while pending restoration can proceed under the regular attempt budget.

## Manual release checks still required

- Finish the actual-account Phase 3 guide, including other-field preservation, background live execution and interrupted-save recovery. Set unattended confirmation only after these checks.
- Preview and install the task while Off. Confirm its account, triggers, action, no-wake/no-catch-up settings and actual status in Windows.
- Turn On for a supervised eligible attempt. Close the dashboard and verify the independent worker continues and records one completed update.
- Reopen the dashboard; test Off during a retry wait, task pause/resume and removal. Verify no new reservations, no budget reset and graceful restoration of any active cycle.
- Exercise overlapping triggers, sign-out/sign-in, shutdown/restart and sleep across multiple hours. Confirm one eligible attempt after resume and no missed-hour replay.
- Review a ten-hour pilot for exact restoration, completed/failed counts, authentication challenges and daily totals. Local mock tests and task XML preview do not establish these results.

## Stop or remove the project

Choose how much to remove:

1. **Stop updates and keep the setup.** Turn Off in the dashboard. Wait for any reserved attempt to finish and verify that the original Name is restored. Close the dashboard terminal if you no longer need it.
2. **Remove Windows startup integration.** From the project folder, run `.\scripts\install-task.ps1 -Remove`. This removes both `NaukriProfileScheduler` and `NaukriProfileScheduler-Session` from the root Task Scheduler Library. You can also remove those exact entries in Task Scheduler. Give any active worker time to exit before removing its files. Keep the source and local files if you plan to reinstall.
3. **Remove only the local login or dependencies.** With the worker and project browser closed, removing `.local/browser/` removes the saved project browser session. You will need to log in again before reuse. Removing `node_modules/` frees dependency files, which can be reinstalled with `npm ci`. Keep the recovery journal until you have verified restoration.
4. **Remove the entire local app.** After removing the tasks, closing the dashboard and confirming restoration, delete the project folder if you no longer need it. This removes the source, local Git history, npm dependencies, configuration, saved browser session, validation, recovery state and logs in one step. Node.js, Git, Git Credential Manager and your normal Chrome or Edge installation are shared tools you can keep.

Check for any remaining task registrations with this read-only command:

```powershell
Get-ScheduledTask -TaskName 'NaukriProfileScheduler*' -ErrorAction SilentlyContinue
```

### What remains outside your computer

GitHub keeps the published repository separately. Removing the local checkout or either Windows task leaves that repository available. If you also want the GitHub copy removed, GitHub repository deletion is a separate action. Naukri also keeps the profile on its own servers. Verify the original Name there before discarding any pending recovery data.

### How the GitHub push was authorized

Git commits are created locally. Git's configured name and email are author metadata. Publishing a commit uses a separate credential and requires write access to the destination repository. This project uses an HTTPS remote, and Git on this Windows installation is configured with Git Credential Manager. The push succeeded without a new login, which is consistent with Git reusing an existing credential. The successful push confirms write authorization for that operation. It does not tell us when the credential was created or how the initial sign-in happened. See [GitHub authentication](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github) and [Git Credential Manager](https://docs.github.com/en/get-started/git-basics/caching-your-github-credentials-in-git).

A public repository lets anyone read and clone it. Direct pushes require write access and must satisfy the branch rules. Someone without write access can contribute through a fork and a pull request. GitHub does not convert rejected pushes into pull requests. In this case GitHub accepted a regular push to `main` that preserved the repository's initial commit. To require pull requests for future changes, configure a rule for `main` and review who can bypass it. See [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
