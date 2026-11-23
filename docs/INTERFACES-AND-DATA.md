# Interfaces and data (Phase 2)

No database or public HTTP API is needed. Phase 2 uses local commands and files. A private loopback dashboard control interface is planned for Phase 4; no API is implemented for it yet. Naukri is accessed through its web UI, not an undocumented API.

| Command | Behavior |
|---|---|
| `login` / `inspect` | Visible dedicated browser and Playwright Inspector; manual authentication |
| `dry-run` | Open verified Basic details; do not fill or submit |
| `save` | Full two-save cycle, or reconciliation of pending recovery; shared budget |
| `recover` | Restoration only; activation and shared budget still apply |
| `status` | Redacted last outcome, pending recovery, budget and history totals |

Save/recover emit structured outcomes: `restored`, `failed`, `skipped`, `nothing-to-recover`. A transient first failure can emit `retry-scheduled` and one further result. Final failure exits 1, as do invalid state/config/lock errors; normal completion and skips exit 0. Generic CLI errors intentionally omit raw browser exception text. Status reports scheduler `not-checked` until Phase 4 integration.

## Local config

`config.local.json` is ignored by Git; `config.example.json` is the template. Defaults: `enabled: false`, `permissionConfirmed: false`, `headless: true`, `browserChannel: chrome`, `minimumIntervalMinutes: 60`, `timeoutMs: 30000`. Old configs without browserChannel fall back to Edge. Allowed browser channels are chrome/msedge; timeout range is 1000–120000 ms, minimum interval at least 60 minutes.

`profileUrl` must use HTTPS and exact hostname www.naukri.com. Required nonempty selectors: `edit` (scoped top-card control), `editor` (modal), `name` (unique CSS input selector inside modal), `close` and `save` (inside modal), `success`, `challenge`, `validationError` (page-relative). The editor must expose exact accessible heading Basic details. No production selectors are guessed. Dry-run may pass with Save disabled before mutation.

## Persistence

| File under `.local/` | Contents |
|---|---|
| `browser/` | Sensitive browser session; never share or commit |
| `pending-cycle.json` | version, id, originalName, temporaryName, phase, startedAt, optional temporaryVerified |
| `budget.json` | version, window startedAt, intervalMs, cycleId, closed/blocked, attempts (id, startedAt, failedAt on failure, action, outcome, reason) |
| `state.json` | lastAttemptAt, lastSuccessAt, status, cycleId, generic lastError |
| `history.jsonl` | version, eventId, cycleId, attemptId, UTC at, action, outcome, optional phase/reason; no Name values |
| `run.lock` | PID and start time; exclusive handle prevents concurrent execution |

Journal phases: prepared, temporary-submit-intent, temporary-verified, restore-submit-intent, restored. `temporaryVerified` survives later phases; restored alone does not establish a completed update. Completion event ID is stable per cycle, and failure IDs are stable per attempt. History rejects malformed records and deduplicates IDs. An interrupted history append may require manual repair; no silent truncation is performed.

Budget allows two attempts in one elapsed-time window. It is reserved before browser launch and cannot reset on CLI restart. Recovery shares that budget. Old prototype lastAttemptAt is respected during migration if no budget exists. `recover` with no pending journal is a no-op.

History outcomes: attempt-started, cycle-failed, recovery-failed, cycle-completed, recovery-restored. Failed attempts remain counted after recovery. Completed updates require a verified temporary milestone plus exact restoration; deduplicate by cycle ID. Daily metrics use Asia/Calcutta. No log retention/rotation or dashboard rendering exists yet.
