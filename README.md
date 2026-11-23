# Naukri Profile Scheduler

Free local Windows automation with no AI runtime, cloud service or database. One cycle opens **Basic details**, appends one full stop to Name, saves, reopens and restores the exact original Name, then saves and verifies restoration. The Resume headline dialog is never a target.

## Current status

Phases 1–2 are implemented with control and local browser tests. The live Naukri selectors, permission and site compatibility are not verified. Scheduling and the dashboard are not active. Local Git is initialized; no commit, remote or publication has been made.

The app defaults Off. A background browser and repeated saves are not a guarantee of Naukri permission, lack of detection or improved visibility.

## Install on Windows

Requires Node.js 22+ and installed Google Chrome or Microsoft Edge. On another computer, install dependencies and log in separately. Never transfer session data via GitHub.

```powershell
npm ci
Copy-Item config.example.json config.local.json
npm run login
```

Set `browserChannel` to `chrome` or `msedge` in local config. Chrome now defaults in the example; older configs without that setting use Edge. Login opens a dedicated visible browser with Playwright Inspector. Log in manually and click Resume when finished. Your ordinary Chrome workspace remains separate. Passwords are not application configuration; sensitive session data stays under `.local/browser`.

## Configure and validate (Phase 3)

Use `npm run inspect` to inspect the actual authenticated page. Configure explicit selectors for the top identity-card Edit control (`edit`), modal container (`editor`), Name input (`name`), modal close (`close`), Save (`save`), new success indicator (`success`), login/OTP/CAPTCHA indicators (`challenge`) and validation errors (`validationError`). `name` must be a CSS selector for the unique input. `name`, `close` and `save` are relative to the modal; others are page-relative. The modal must contain the accessible exact heading **Basic details**; verify this in inspection. Never infer the editor from its URL.

Run `npm run dry-run`. It opens the verified editor without filling or submitting. Save may be disabled before an edit. No guessed production selectors are supplied.

Once site permission is established and you are ready for a supervised live check, set `permissionConfirmed` and `enabled` to true, then use `npm run save`. The app will perform real profile edits when enabled and configured. Confirm the original Name is restored. Set `enabled` back to false to prevent further write attempts.

## Commands and outcomes

- `npm run status`: redacted cycle status, budget, completed updates, failed attempts and IST daily totals. Scheduler state is currently not checked.
- `npm run save`: one full cycle or pending restoration, within the shared budget.
- `npm run recover`: pending restoration only, within the same budget and activation gates.
- `npm test`: all unit and mock browser tests; needs Edge for the browser test suite. Tests route mock requests locally and do not use Naukri.

Each 60-minute window allows the first attempt and one retry at least 60 seconds after a transient failure completes. Failure time is persisted; slow attempts cannot skip the delay. After two failures, **no more attempts, including recovery**, until the next window. The two saves are one attempt, not two attempts. CAPTCHA, rate limiting, validation rejection and conflicts stop automatic retries, including when they interrupt navigation or clicks. If security state cannot be inspected after a browser error, stop without retrying. Restarting or manual commands do not reset the budget. Lost confirmations are reconciled before further writes. A temporary period may remain visible until restoration can succeed.

The CLI waits for one eligible retry and rechecks activation before it starts. Turning Off cancels a waiting retry; a running attempt may finish restoring the original Name. A future dashboard On/Off control is Phase 4 scope.

## Local files and recovery

`.local/pending-cycle.json` contains private original/temporary names and milestones. `.local/budget.json` stores attempts and next eligibility. `.local/history.jsonl` contains durable redacted outcomes. `.local/state.json` contains the last outcome. History corruption fails closed; no silent reset or automatic log rotation is provided.

One completed update requires verified temporary submission and exact restoration, counted once by cycle ID. A restoration alone does not fabricate an update. Failed attempts remain counted after later success. Status and history never include Name values.

A crash can leave `.local/run.lock`. Check its recorded PID and confirm this app is not running before manually removing it; never delete a lock merely because it is old. Do not delete pending journal or budget files to bypass limits. Login/OTP/CAPTCHA requires manual attention.

## Schedule and GitHub

The existing `scripts/install-task.ps1` is retained from the initial prototype; do not install it yet. Phase 4 will implement sign-in/resume handling, hourly execution and a default-Off local dashboard with On/Off control. No wake or missed-hour burst is intended.

`.local/`, `config.local.json`, `.env` files and dependencies are Git-ignored. Only source, tests, example config, documentation and lockfile should be published. No commit or GitHub push will be made until the user requests it. Avoid running this against the same account from multiple computers: local budgets cannot coordinate between machines.

Documentation: [PRD](docs/PRD.md), [architecture](docs/ARCHITECTURE.md), [interfaces/data](docs/INTERFACES-AND-DATA.md), [Name workflow](docs/NAME-UPDATE-WORKFLOW.md), [retry policy](docs/RETRY-POLICY.md), [dashboard/scheduling](docs/DASHBOARD-AND-SCHEDULING.md), [implementation checkpoints](docs/IMPLEMENTATION-PHASES.md).
