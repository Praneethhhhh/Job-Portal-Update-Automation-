import { randomUUID } from 'node:crypto';

export function validateBudget(budget) {
  if (!budget || budget.version !== 1 || !Number.isFinite(Date.parse(budget.startedAt)) ||
      (budget.mode !== undefined && !['minute-test', 'scheduled'].includes(budget.mode)) ||
      !validInterval(budget.mode, budget.intervalMs) ||
      typeof budget.cycleId !== 'string' || !budget.cycleId ||
      typeof budget.closed !== 'boolean' || typeof budget.blocked !== 'boolean' ||
      !Array.isArray(budget.attempts) || budget.attempts.length < 1 || budget.attempts.length > 2 ||
      budget.attempts.some(a => !a.id || !Number.isFinite(Date.parse(a.startedAt)) ||
        (a.failedAt !== undefined && (!Number.isFinite(Date.parse(a.failedAt)) || Date.parse(a.failedAt) < Date.parse(a.startedAt))) ||
        !['running', 'failed', 'success'].includes(a.outcome) || !['cycle', 'recovery'].includes(a.action))) {
    throw new Error('Invalid hourly budget; manual reconciliation required');
  }
  return budget;
}

function validInterval(mode, ms) {
  if (!Number.isFinite(ms)) return false;
  if (mode === 'minute-test') return ms === 60000;
  if (mode === 'scheduled') return ms >= 1500000 && ms <= 2700000 && ms % 1000 === 0;
  return ms >= 3600000;
}

export function budgetStatus(budget, now = Date.now()) {
  if (!budget) return { attemptsUsed: 0, maxAttempts: 2, nextEligibleAt: null, budgetState: 'ready' };
  validateBudget(budget);
  const end = Date.parse(budget.startedAt) + budget.intervalMs;
  const last = budget.attempts.at(-1);
  // Legacy failed records have no completion time. Until migration persists
  // one, conservatively wait from detection rather than guessing from start.
  const retryAt = Date.parse(last.failedAt ?? new Date(now).toISOString()) + 60000;
  const exhausted = budget.closed || budget.blocked || budget.attempts.length >= 2;
  const next = budget.closed || budget.blocked ? end : exhausted ? Math.max(end, retryAt) : retryAt;
  return {
    attemptsUsed: budget.attempts.length, maxAttempts: 2,
    nextEligibleAt: new Date(next).toISOString(),
    budgetState: now >= end && now >= next ? 'ready' : budget.closed ? 'completed' : budget.blocked ? 'manual-attention' :
      budget.attempts.length >= 2 ? 'exhausted' : now < retryAt ? 'retry-wait' : 'retry-ready'
  };
}

export function reserveAttempt(previous, { now, minimumIntervalMinutes, cycleId, action, minuteTest = false, scheduledIntervalMs }) {
  if (minuteTest ? minimumIntervalMinutes !== 1 : minimumIntervalMinutes < 60) throw new Error('Invalid attempt interval');
  if (previous) validateBudget(previous);
  if (previous && (previous.mode === 'minute-test') !== minuteTest) throw new Error('Budget mode mismatch');
  if (previous) {
    const status = budgetStatus(previous, now);
    if (!['ready', 'retry-ready'].includes(status.budgetState)) return { skipped: true, ...status };
  }
  const active = previous && now < Date.parse(previous.startedAt) + previous.intervalMs;
  const budget = active ? structuredClone(previous) : {
    version: 1, startedAt: new Date(now).toISOString(), intervalMs: scheduledIntervalMs ?? minimumIntervalMinutes * 60000,
    cycleId: cycleId ?? randomUUID(), closed: false, blocked: false, attempts: []
  };
  if (minuteTest) budget.mode = 'minute-test';
  if (!active && scheduledIntervalMs !== undefined) {
    if (minuteTest || !validInterval('scheduled', scheduledIntervalMs) || scheduledIntervalMs > 2100000) throw new Error('Invalid scheduled interval');
    budget.mode = 'scheduled';
  }
  const attempt = { id: randomUUID(), startedAt: new Date(now).toISOString(), action, outcome: 'running' };
  budget.attempts.push(attempt);
  return { budget, attempt };
}
