# Naukri Profile Scheduler

Free local Windows automation with no AI runtime, cloud service or database. One cycle opens **Basic details**, appends one full stop to Name, saves, reopens and restores the exact original Name, then saves and verifies restoration. The Resume headline dialog is never a target.

## Current status

Phases 1–2, Phase 3 validation tooling and Phase 4 dashboard/scheduler code are implemented with control and local browser tests. Live Naukri validation and the Windows schedule pilot remain pending. No Windows task is installed by starting the dashboard. Source is stored in local Git; GitHub publishing is deferred.

The app defaults Off. A background browser and repeated saves are not a guarantee of Naukri permission, lack of detection or improved visibility.

## Install on Windows

Requires Node.js 22+ and installed Google Chrome or Microsoft Edge. On another computer, install dependencies and log in separately. Never transfer session data via GitHub.

```powershell
npm ci
Copy-Item config.example.json config.local.json
npm run login
```

Set `browserChannel` to `chrome` or `msedge` in local config. Chrome now defaults in the example; older configs without that setting use Edge. Login opens a dedicated visible browser with Playwright Inspector. Log in manually and click Resume when finished. Your ordinary Chrome workspace remains separate. Passwords are not application configuration; sensitive session data stays under `.local/browser`.

Clicking Resume saves/closes the inspection session; it does not discover selectors or turn the workflow On. The dashboard shows saved-session presence separately from page checks and the supervised test. For developer diagnostics, `npm run inspect -- --report` prints a redacted control inventory; add `--keep-open` to leave that read-only inspection window open until you close it. `--open-editor` accepts the unique Edit locator observed in the actual page and opens only that editor. No report command fills or submits fields.

## Configure and validate (Phase 3)

Use `npm run inspect` to inspect the actual authenticated page. Configure explicit selectors for the top identity-card Edit control (`edit`), modal container (`editor`), Name input (`name`), modal close (`close`), Save (`save`), new success indicator (`success`), login/OTP/CAPTCHA indicators (`challenge`) and validation errors (`validationError`). `name` must be a CSS selector for the unique input. `name`, `close` and `save` are relative to the modal; others are page-relative. The modal must contain the accessible exact heading **Basic details**; verify this in inspection. Never infer the editor from its URL.

Run `npm run dry-run`. It opens the verified editor without filling or submitting. Save may be disabled before an edit. No guessed production selectors are supplied.

The exact **Basic details** title can be a plain text element on the live site. Set the optional modal-relative `selectors.heading` to that observed element; the adapter still checks its exact text. `confirmationMode: "persisted-editor"` supports sites that omit a repeat toast: after Save, the modal must close and a fresh navigation must show the exact requested Name. Closing alone is never success. In this mode `success` is optional. Missing `challenge`/`validationError` selectors use conservative built-in CAPTCHA/login/native-invalid detection; configure explicit site-specific selectors where available. The default `toast-and-editor` mode still requires a fresh configured success indicator and reopened persisted-value verification.

Every Save waits at least **five seconds** before the editor is reopened. The sequence is: append one period, Save, wait five seconds, reopen/verify, restore the exact original, Save, wait five seconds, reopen/verify, then close. `postSaveDelayMs` defaults to `5000` and cannot be set below that. The persisted-editor adapter reuses its fresh server read once so the coordinator does not immediately reload the same page again. Pacing reduces request frequency; it does not certify that a site permits automation.

For the guided Phase 3 checks, run:

```powershell
npm run check-setup
npm run verify
npm run verify -- --background
```

`check-setup` is offline and read-only: it reports configuration, activation, session-directory presence, recovery, lock, budget and validation evidence without displaying private values. `verify` opens a visible dedicated browser and records a read-only dry-run. `--background` checks the headless browser separately. Both work while Off and never submit or reserve a workflow attempt. Session-directory presence does not establish that login is still valid.

After both checks pass, manually confirm site permission and set `permissionConfirmed` and `enabled` to true. Run `npm run verify-save` for **one supervised live two-save attempt** in a visible browser. This makes real profile edits and verifies exact restoration through the normal coordinator. It honors activation, recovery, lock and budget; it does not automatically retry. If it fails, inspect `npm run status` and reconcile pending recovery before proceeding. A recovery-only result cannot certify a fresh two-save validation.

Results are stored privately in `.local/validation.json`, with only check names, timestamps, statuses and a configuration hash. Changing selectors, URL, browser, timeout or interval invalidates matching evidence; rerunning a dry-run invalidates the previous live-save result. `npm run check-setup` shows the current evidence. Passing these checks does not certify site permission or complete the manual background/save and recovery checks in [the Phase 3 guide](docs/SUPERVISED-VALIDATION.md).

Once site permission is established and you are ready for a supervised live check, set `permissionConfirmed` and `enabled` to true, then use `npm run save`. The app will perform real profile edits when enabled and configured. Confirm the original Name is restored. Set `enabled` back to false to prevent further write attempts.

## Commands and outcomes

- `npm run status`: redacted cycle status, budget, completed updates, failed attempts, IST daily totals and actual Windows task state (unknown if unavailable).
- `npm run dashboard`: local dashboard at `http://127.0.0.1:4317`, with validated On/Off control, counts, recovery and recent activity.
- `npm run scheduler`: foreground worker for operational testing; the dashboard need not remain open. Requires the unattended validation gates before any attempt.
- `npm run test-minute`: explicitly requested, bounded live test of two visible cycles, with one minute between completed cycles and five seconds after each Save. Requires saved setup/site permission and the normal workflow Off. Stops on the first failure and never starts automatic retries.
- `npm run save`: one full cycle or pending restoration, within the shared budget.
- `npm run recover`: pending restoration only, within the same budget and activation gates.
- `npm test`: all unit and mock browser tests; needs Edge for the browser test suite. Tests route mock requests locally and do not use Naukri.

Each 60-minute window allows the first attempt and one retry at least 60 seconds after a transient failure completes. Failure time is persisted; slow attempts cannot skip the delay. After two failures, **no more attempts, including recovery**, until the next window. The two saves are one attempt, not two attempts. CAPTCHA, rate limiting, validation rejection and conflicts stop automatic retries, including when they interrupt navigation or clicks. If security state cannot be inspected after a browser error, stop without retrying. Restarting or manual commands do not reset the budget. Lost confirmations are reconciled before further writes. A temporary period may remain visible until restoration can succeed.

The CLI waits for one eligible retry and rechecks activation before it starts. The scheduled worker checks persisted eligibility every 15 seconds; it never queues missed hours. Turning Off cancels a waiting retry; a running attempt may finish restoring the original Name. The dashboard writes the same persisted activation flag without resetting the budget.

## Local files and recovery

`.local/pending-cycle.json` contains private original/temporary names and milestones. `.local/budget.json` stores attempts and next eligibility. `.local/history.jsonl` contains durable redacted outcomes. `.local/state.json` contains the last outcome. History corruption fails closed; no silent reset or automatic log rotation is provided.

One completed update requires verified temporary submission and exact restoration, counted once by cycle ID. A restoration alone does not fabricate an update. Failed attempts remain counted after later success. Status and history never include Name values.

A crash can leave `.local/run.lock`, `.local/runner/run.lock` or `.local/control/run.lock`. Check the recorded PID and confirm the corresponding process is not running before manually removing a stale lock; never delete a lock merely because it is old. Do not delete pending journal or budget files to bypass limits. Login/OTP/CAPTCHA requires manual attention.

## Schedule and GitHub

Start `npm run dashboard` to inspect status while the workflow is Off. The dashboard uses only loopback HTTP and local assets. It rejects foreign Host/Origin requests, requires a per-process CSRF token for On/Off, and displays only redacted status. Keep its terminal running while using the page. Closing the dashboard process does not stop the independent Windows worker.

Before installing or turning On unattended operation, complete both recorded dry-runs, `npm run verify-save` and the remaining manual checks in the Phase 3 guide. Set `unattendedConfirmed` to the JSON boolean `true` only after those checks. Installation may happen while `enabled` remains false. The runner and dashboard reject stale/missing validation evidence and missing permission; they do not infer permission from test results.

```powershell
.\scripts\install-task.ps1 -Preview # Show task XML without installing anything
.\scripts\install-task.ps1          # Install and start the worker after validation
.\scripts\install-task.ps1 -Pause
.\scripts\install-task.ps1 -Resume
.\scripts\install-task.ps1 -Remove
```

Before installing on Windows, run `.\scripts\protect-project.ps1` as the project owner. It limits checkout access to that account, SYSTEM, and administrators. This protects the scheduled scripts, configuration, and saved browser profile.

The task uses a hidden launcher in the signed-in Windows session. Sign-in and wake signal a fresh cycle when the workflow is On and any pending recovery or retry limits allow it. Subsequent scheduled cycles use a delay of 35 to 45 minutes from the start of the previous cycle, chosen in whole seconds and saved in the attempt budget. The five-minute Windows backup timer starts the worker if needed. The laptop stays asleep until you wake it.

`.local/`, `config.local.json`, `.env` files and dependencies are Git-ignored. Only source, tests, example config, documentation and lockfile should be published. No commit or GitHub push will be made until the user requests it. Avoid running this against the same account from multiple computers: local budgets cannot coordinate between machines.

Documentation: [PRD](docs/PRD.md), [architecture](docs/ARCHITECTURE.md), [interfaces/data](docs/INTERFACES-AND-DATA.md), [Name workflow](docs/NAME-UPDATE-WORKFLOW.md), [retry policy](docs/RETRY-POLICY.md), [dashboard/scheduling](docs/DASHBOARD-AND-SCHEDULING.md), [implementation checkpoints](docs/IMPLEMENTATION-PHASES.md).
