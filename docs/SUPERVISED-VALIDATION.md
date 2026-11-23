# Phase 3: supervised validation

The validation commands are implemented. Actual Naukri login, selectors, permission and live behavior still require the account owner. Scheduling remains inactive until those checks and Phase 4 are complete.

## 1. Inspect setup without opening a browser

Run `npm run check-setup`. This reads local configuration, journal, budget, lock and history and reports fixed, non-sensitive checks. It never edits configuration, launches a browser, resets state or makes network requests. Node.js 22+, configured selectors and an installed supported browser are needed. Browser installation and authentication are tested when you run the browser checks; a session directory alone proves neither.

If configuration is absent, copy `config.example.json` to `config.local.json`. Keep `enabled` false during setup. Use `npm run login` to authenticate manually and `npm run inspect` to inspect the actual controls. Configure the required selectors described in the README. Confirm the exact Basic details heading and the top identity-card Edit control. Do not infer selector correctness from a URL or screenshot.

If a journal or lock exists, inspect `npm run status` and the recorded lock PID. Reconcile recovery within the existing budget. Never remove journals or budgets to make validation eligible.

## 2. Verify the selected browser mode

Run `npm run verify`, observe the dedicated visible browser, and confirm the correct dialog opened. It reads the Name field and locates Save without filling or submitting. For a configuration using headless mode, use `npm run verify -- --background` instead. These commands work while Off, share the browser lock, and do not consume workflow budget.

Each command records passed/failed evidence and exits nonzero on failure. Raw errors and Name values are not written to evidence. Fix a failed check before proceeding. A browser that closes unexpectedly or encounters authentication requires manual inspection; the verification command does not retry it.

## 3. Supervise one full cycle

Establish permission for the actual two-edit workflow separately. Set `permissionConfirmed` and `enabled` to the JSON boolean `true`, then run `npm run verify-save`. This command makes real edits in the configured browser mode. It requires the passing read-only check for the configured mode and executes exactly one attempt. Changing `headless` requires a fresh supervised cycle in that mode. Older supervised results without a recorded mode also require a fresh cycle.

Observe the temporary full stop, both submissions and exact restoration. A successful new cycle records `supervisedCycle: passed`. Lost confirmations, conflicts or recovery-only work cannot establish fresh-cycle validation. A cooldown skip preserves prior evidence but does not claim a new successful check. If a failure leaves pending recovery, inspect status and use the existing recovery command when eligible; this verifier will not automatically retry. Turn `enabled` false after supervised testing.

## 4. Review evidence and remaining manual checks

Run `npm run check-setup` again. `.local/validation.json` stores only check names, timestamps, statuses and a SHA-256 hash of the relevant configuration. Selector ordering and activation toggles do not invalidate evidence. Changes to URL, selectors, browser, timeout or interval do. Rerunning the read-only check for the previously supervised browser mode clears prior supervised-cycle evidence so the new sequence needs a fresh live check. Treat the evidence as local operational records, not tamper-proof certification.

Before marking Phase 3 complete, separately observe background live execution while using another application, exact preservation of other fields, expired-session handling and recovery after an interrupted save. Verify permission manually. The `liveChecksPassed` flag records that the configured browser mode passed its read-only check and supervised cycle. Phase 4 implements and validates scheduling and the local dashboard.
