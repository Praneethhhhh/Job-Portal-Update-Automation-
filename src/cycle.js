import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLock, due, readJson, writeJson } from './core.js';
import { reserveAttempt, budgetStatus, validateBudget } from './budget.js';
import { recordHistory, readHistory } from './history.js';
import { WorkflowError, failureCode } from './errors.js';
import { validateTestSession } from './test-session.js';

const editorChangedBeforeSave = reason => ['other-fields-changed', 'editor-changed-before-save'].includes(reason);

export const phases = ['prepared', 'temporary-submit-intent', 'temporary-verified', 'restore-submit-intent', 'restored'];

export function createCycle(originalName) {
  if (typeof originalName !== 'string' || !originalName.trim()) throw new Error('Name must be a nonempty string');
  return { version: 1, id: randomUUID(), originalName, temporaryName: originalName + '.', phase: 'prepared', startedAt: new Date().toISOString() };
}

export function validateCycle(cycle) {
  if (!cycle || cycle.version !== 1 || typeof cycle.id !== 'string' || !cycle.id ||
      typeof cycle.originalName !== 'string' || !cycle.originalName.trim() ||
      cycle.temporaryName !== cycle.originalName + '.' || !phases.includes(cycle.phase) ||
      typeof cycle.startedAt !== 'string' || !Number.isFinite(Date.parse(cycle.startedAt)) ||
      (cycle.temporaryVerified !== undefined && typeof cycle.temporaryVerified !== 'boolean')) {
    throw new Error('Invalid recovery journal; manual reconciliation required');
  }
  return cycle;
}

export function recoveryDecision(cycle, observedName) {
  validateCycle(cycle);
  if (observedName === cycle.originalName) return 'complete';
  if (observedName === cycle.temporaryName) return 'restore';
  return 'conflict';
}

export function publicCycleStatus(cycle) {
  if (!cycle) return { pendingCycle: false, restorationRequired: false };
  validateCycle(cycle);
  return { pendingCycle: true, cycleId: cycle.id, phase: cycle.phase, restorationRequired: true };
}

/**
 * Adapter contract (browser implementation follows in Phase 2):
 * readName(): reopen the verified editor and return the persisted Name.
 * saveName(expectedName, nextName): recheck editor identity, expected Name and
 * all other fields, submit once and require a fresh confirmation. Never retry.
 * Throw on challenge, conflict or ambiguous result. Exceptions may contain PII;
 * this layer never persists exception messages.
 */
export async function runCycle({ directory, adapter, minimumIntervalMinutes = 60, recoverOnly = false, now = Date.now(), authorize = async () => true, clock, closeAdapter = false, minuteTestSessionId, sessionStartedAt, scheduledIntervalMs, lockReservation }) {
  const minuteTest = typeof minuteTestSessionId === 'string' && !!minuteTestSessionId;
  if (!Number.isFinite(minimumIntervalMinutes) || (minuteTest ? minimumIntervalMinutes !== 1 : minimumIntervalMinutes < 60)) throw new Error('Minimum interval must be at least 60 minutes outside a bounded minute test');
  await fs.mkdir(directory, { recursive: true });
  const release = await acquireLock(directory);
  const journalFile = path.join(directory, 'pending-cycle.json');
  const stateFile = path.join(directory, 'state.json');
  const budgetFile = path.join(directory, minuteTest ? 'minute-test-budget.json' : 'budget.json');
  const testFile = path.join(directory, 'minute-test.json');
  let cycle;
  let budget, attempt;
  const clockStart = Date.now();
  const currentTime = clock ?? (() => now + Date.now() - clockStart);
  const timestamp = () => new Date(currentTime()).toISOString();
  const event = (outcome, eventId, reason) => recordHistory(directory, {
    eventId, cycleId: cycle?.id ?? budget.cycleId, attemptId: attempt.id,
    at: timestamp(), action: attempt.action, outcome, phase: cycle?.phase ?? 'before-editor',
    ...(minuteTest ? { mode: 'minute-test' } : {}),
    ...(reason ? { reason } : {})
  });
  const persist = async phase => {
    cycle = { ...cycle, phase };
    validateCycle(cycle);
    await writeJson(journalFile, cycle);
  };
  const finish = async () => {
    await persist('restored');
    // Completion is durably recorded before clearing the journal. Replaying this
    // finalization uses the same IDs and cannot inflate dashboard counts.
    if (cycle.temporaryVerified === true) await event('cycle-completed', `${cycle.id}:completed`);
    if (attempt.action === 'recovery') await event('recovery-restored', `${attempt.id}:restored`);
    const state = await readJson(stateFile, {});
    await writeJson(stateFile, { ...state, status: 'success', lastSuccessAt: timestamp(), cycleId: cycle.id, lastError: null });
    attempt.outcome = 'success';
    budget.closed = true;
    await writeJson(budgetFile, budget);
    await fs.unlink(journalFile);
    return { outcome: 'restored', cycleId: cycle.id };
  };
  const restore = async observed => {
    const decision = recoveryDecision(cycle, observed);
    if (decision === 'conflict') throw new WorkflowError('name-conflict');
    if (decision === 'complete') return finish();
    await persist('restore-submit-intent');
    await adapter.saveName(cycle.temporaryName, cycle.originalName);
    if (await adapter.readName() !== cycle.originalName) throw new WorkflowError('restoration-unverified', true);
    return finish();
  };
  let releaseReservation;
  try {
    if (!(await authorize())) return { outcome: 'skipped', reason: 'workflow-off' };
    cycle = await readJson(journalFile, null);
    if (cycle) validateCycle(cycle);
    const testSession = await readJson(testFile, null);
    if (testSession) validateTestSession(testSession);
    if (minuteTest) {
      if (!testSession || testSession.id !== minuteTestSessionId || testSession.status !== 'running' ||
          now >= Date.parse(testSession.expiresAt) || testSession.cyclesStarted >= 2) return { outcome: 'skipped', reason: 'minute-test-ended' };
    } else if (testSession) {
      if (testSession.status === 'running' && now < Date.parse(testSession.expiresAt)) return { outcome: 'skipped', reason: 'minute-test-running' };
      const next = Date.parse(testSession.lastAttemptAt) + minimumIntervalMinutes * 60000;
      if (!cycle && testSession.lastAttemptAt && now < next && !(sessionStartedAt > Date.parse(testSession.lastAttemptAt))) return { outcome: 'skipped', reason: 'minimum-interval-after-test', nextEligibleAt: new Date(next).toISOString() };
    }
    // Validate storage before reserving or accessing the browser.
    const history = await readHistory(directory);
    if (recoverOnly && !cycle) return { outcome: 'nothing-to-recover' };
    const state = await readJson(stateFile, {});
    const previous = await readJson(budgetFile, null);
    let unusedJournal = false;
    if (previous) {
      validateBudget(previous);
      let budgetChanged = false;
      const interrupted = previous.attempts.at(-1);
      const rejectedBeforeSave = interrupted.outcome === 'failed' && editorChangedBeforeSave(interrupted.reason);
      // Migrate older attempts that classified this local form guard as permanent.
      if (previous.blocked && rejectedBeforeSave) {
        previous.blocked = false;
        budgetChanged = true;
      }
      unusedJournal = cycle?.phase === 'temporary-submit-intent' && cycle.id === previous.cycleId &&
        interrupted.action === 'cycle' && rejectedBeforeSave && (interrupted.stoppedBeforeSave === true || history.some(row =>
          row.eventId === `${interrupted.id}:failed` && row.cycleId === cycle.id &&
          row.phase === cycle.phase && row.reason === interrupted.reason));
      if (interrupted.outcome === 'running') {
        interrupted.outcome = 'failed';
        interrupted.reason = 'process-interrupted';
        budgetChanged = true;
      }
      // A crash/legacy record has an unknown failure time: start the delay when
      // detected, and persist it so restarts cannot shorten or reset the delay.
      for (const prior of previous.attempts.filter(a => a.outcome === 'failed' && !a.failedAt)) {
        prior.failedAt = timestamp();
        budgetChanged = true;
      }
      if (budgetChanged) await writeJson(budgetFile, previous);
      // Idempotently repair a missing failure event after a process/storage
      // interruption, including a crash between budget and history writes.
      for (const prior of previous.attempts.filter(a => a.outcome === 'failed')) {
        if (history.some(row => row.eventId === `${prior.id}:failed`)) continue;
        await recordHistory(directory, {
          eventId: `${prior.id}:failed`, cycleId: previous.cycleId, attemptId: prior.id,
          at: prior.failedAt, action: prior.action,
          outcome: prior.action === 'recovery' ? 'recovery-failed' : 'cycle-failed', reason: prior.reason ?? 'process-interrupted'
        });
      }
    }
    if (unusedJournal && recoverOnly) {
      await fs.unlink(journalFile);
      return { outcome: 'nothing-to-recover', reason: 'no-save-was-sent' };
    }
    // Preserve the earlier prototype's cooldown during migration.
    if (!minuteTest && !previous && !cycle && !(sessionStartedAt > Date.parse(state.lastSuccessAt)) &&
        !due(state, { minimumIntervalMinutes }, now)) return { outcome: 'skipped', reason: 'minimum-interval' };
    // A new Windows session starts a new budget after transient failures too.
    // Access restrictions and other manual-attention failures keep their block.
    const freshSession = !minuteTest && previous && !previous.blocked &&
      sessionStartedAt > Math.max(Date.parse(previous.attempts.at(-1).startedAt), Date.parse(state.lastSuccessAt) || 0);
    if (freshSession && previous.attempts.at(-1).outcome === 'failed') {
      const retryAt = Date.parse(previous.attempts.at(-1).failedAt) + 60000;
      if (now < retryAt) return { outcome: 'skipped', reason: 'retry-wait', nextEligibleAt: new Date(retryAt).toISOString() };
    }
    const resumeCycle = unusedJournal ? null : cycle;
    const reserved = reserveAttempt(freshSession ? null : previous, { now, minimumIntervalMinutes, cycleId: resumeCycle?.id, action: resumeCycle ? 'recovery' : 'cycle', minuteTest, scheduledIntervalMs });
    if (reserved.skipped) return { outcome: 'skipped', reason: reserved.budgetState, nextEligibleAt: reserved.nextEligibleAt };
    if (lockReservation) {
      releaseReservation = await lockReservation();
      if (!(await authorize({ reservation: true }))) return { outcome: 'skipped', reason: 'workflow-off' };
    }
    if (unusedJournal) {
      await fs.unlink(journalFile);
      cycle = null;
    }
    ({ budget, attempt } = reserved);
    if (minuteTest) {
      testSession.cyclesStarted++;
      testSession.lastAttemptAt = new Date(now).toISOString();
      await writeJson(testFile, testSession);
    }
    await writeJson(budgetFile, budget);
    if (releaseReservation) {
      await releaseReservation();
      releaseReservation = undefined;
    }
    await event('attempt-started', `${attempt.id}:started`);
    await writeJson(stateFile, { ...state, lastAttemptAt: new Date(now).toISOString(), status: 'running', lastError: null });
    if (cycle) return await restore(await adapter.readName());
    cycle = createCycle(await adapter.readName());
    cycle.id = budget.cycleId;
    await persist('prepared');
    await persist('temporary-submit-intent');
    await adapter.saveName(cycle.originalName, cycle.temporaryName);
    if (await adapter.readName() !== cycle.temporaryName) throw new WorkflowError('temporary-change-unverified', true);
    cycle.temporaryVerified = true;
    await persist('temporary-verified');
    return await restore(cycle.temporaryName);
  } catch (error) {
    if (!attempt) throw new Error('Local state invalid; manual reconciliation required');
    const reason = failureCode(error);
    // These adapter outcomes are emitted before clicking Save. Keep the
    // journal if a temporary save may have happened or recovery was underway.
    const stoppedBeforeSave = attempt.action === 'cycle' && cycle?.phase === 'temporary-submit-intent' && editorChangedBeforeSave(reason);
    attempt.outcome = 'failed';
    attempt.failedAt = timestamp();
    const retryable = error instanceof WorkflowError && (error.retryable || editorChangedBeforeSave(reason));
    budget.blocked = !retryable;
    attempt.reason = reason;
    if (stoppedBeforeSave) attempt.stoppedBeforeSave = true;
    await writeJson(budgetFile, budget);
    await event(attempt.action === 'recovery' ? 'recovery-failed' : 'cycle-failed', `${attempt.id}:failed`, reason);
    if (stoppedBeforeSave) await fs.unlink(journalFile);
    const state = await readJson(stateFile, {});
    await writeJson(stateFile, { ...state, status: 'failed', lastError: stoppedBeforeSave
      ? 'Editor changed before submission. No save was sent.'
      : 'Cycle interrupted; inspect pending recovery before another cycle' });
    return { outcome: 'failed', reason, retryable, ...budgetStatus(budget, currentTime()) };
  } finally {
    try {
      await releaseReservation?.();
    } finally {
      try { if (closeAdapter) await adapter.close(); } finally { await release(); }
    }
  }
}
