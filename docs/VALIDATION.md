# Validation and release checklist

## Phase 2 results

The suite contains state/policy/history/control tests, Phase 3 verification tests and 13 real headless Edge tests against intercepted mock routes. These cover the full two-save cycle, same-URL wrong dialog, unchanged other fields, CAPTCHA, lost confirmation/restoration, validation rejection and rate limiting. Regression cases cover login-interrupted navigation/clicks, CAPTCHA/access-restriction interruptions, uninspectable pages, a normal transient click failure, a 90-second failure followed by a full 60-second delay, late-window failures and legacy timestamp migration. No production account or Naukri request is used. Live selectors, site permission, Chrome login and scheduling remain unverified. Dashboard On/Off UI is Phase 4; Phase 2 checks the persisted activation flag before attempts and retries.

## Phase 3 tooling

The verification tests cover redacted dry-run evidence, configuration changes, failed-check invalidation, strict activation, a complete fresh supervised cycle, cooldown preservation, no automatic retry, restoration-only results, locking and corrupt state. Run `npm run check-setup` for offline diagnostics and follow [the supervised validation guide](SUPERVISED-VALIDATION.md) for actual account checks. Tooling coverage does not complete live Phase 3 validation.

## Phase 4 tooling

Operational tests cover explicit unattended readiness, On/Off without budget resets, delayed retry/exhaustion, recovery priority, no missed-hour replay, runner/workflow locks, browser shutdown under the workflow lock, pause gating, Host/Origin/CSRF validation, malformed/oversized requests and redacted corrupt-state reporting. A real Edge browser verifies local dashboard rendering, persisted On/Off and desktop/mobile layouts. Task Scheduler accepted the generated task XML in preview mode, without registration. Actual task installation, Windows lifecycle behavior and the ten-hour pilot remain manual checks in [operation](OPERATION.md).

The updated release must also pass every [strict retry-policy test](RETRY-POLICY.md), the [two-save Name workflow](NAME-UPDATE-WORKFLOW.md) tests and [dashboard/scheduling acceptance checks](DASHBOARD-AND-SCHEDULING.md). The earlier prototype checks below are historical and do not alone establish readiness. In particular, verify there is no third workflow attempt, including recovery, after two failures in a 60-minute window.

## Automated local checks

`npm test` verifies permission/activation gates, host restrictions, required selectors, minimum interval, failed-attempt cooldown, lock exclusivity/release and state round trips. These tests do not validate Naukri or Windows task execution.

## Required supervised integration checks

- Establish permission for the two-save hourly Name cycle and its bounded retry with Naukri; no approval is assumed.
- Log in manually in the dedicated browser. Confirm normal browsing remains independent.
- Inspect the actual top profile editor and configure all selectors, including challenge indicators.
- Run dry-run visible first; confirm correct editor, no value changes and no Save submission.
- Test background dry-run while using another app. Confirm no focus or input interference.
- With activation enabled, perform one supervised save. Confirm fresh success message, unchanged profile content and correct local status.
- Re-run within an hour; verify skip with no browser launch.
- Test expired session and challenge handling without attempting to bypass security controls.
- Install task, inspect its hourly trigger and interactive principal, and observe a scheduled run.
- Sleep across a trigger, resume, and verify no catch-up burst or wake request.
- Test pause, resume and uninstall. Review a ten-hour pilot for failures.

## Known limitations

Actual site controls and anti-automation behavior are unverified. No live save, approved permission, login, task registration or scheduler pilot is implied by passing unit tests. Success verifies the configured UI signal only. No increase in recruiter views is promised. Desktop notifications, log rotation, automatic stale-lock recovery and GUI onboarding remain future work.
