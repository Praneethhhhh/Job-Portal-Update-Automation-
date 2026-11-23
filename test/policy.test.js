import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCycle, createCycle } from '../src/cycle.js';
import { WorkflowError } from '../src/errors.js';
import { readJson, writeJson } from '../src/core.js';
import { readHistory, summarizeHistory, recordHistory } from '../src/history.js';
import { budgetStatus, validateBudget } from '../src/budget.js';
const start = Date.parse('2026-11-23T04:50:00Z'); // 10:20 IST
async function fixture(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-test-'));
  try { await fn(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('two failures exhaust window across fresh invocations; 11:00 blocked until 11:20', async () => fixture(async directory => {
  let reads = 0;
  const adapter = { async readName() { reads++; throw new WorkflowError('offline', true); } };
  assert.equal((await runCycle({ directory, adapter, now: start })).outcome, 'failed');
  assert.equal((await runCycle({ directory, adapter, now: start + 30000 })).reason, 'retry-wait');
  assert.equal((await runCycle({ directory, adapter, now: start + 61000 })).budgetState, 'exhausted');
  assert.equal((await runCycle({ directory, adapter, now: start + 2400000 })).outcome, 'skipped');
  assert.equal(reads, 2);
  assert.equal((await runCycle({ directory, adapter, now: start + 3600000 })).outcome, 'failed');
  assert.equal(reads, 3);
  assert.equal(summarizeHistory(await readHistory(directory), start).failedTotal, 3);
}));

test('first transient navigation failure allows exactly one successful retry', async () => fixture(async directory => {
  let name = 'Original', fail = true, writes = 0;
  const adapter = {
    async readName() { if (fail) { fail = false; throw new WorkflowError('offline', true); } return name; },
    async saveName(expected, next) { assert.equal(name, expected); name = next; writes++; }
  };
  await runCycle({ directory, adapter, now: start });
  assert.equal((await runCycle({ directory, adapter, now: start + 61000 })).outcome, 'restored');
  assert.equal((await runCycle({ directory, adapter, now: start + 120000 })).outcome, 'skipped');
  assert.equal(writes, 2);
  const summary = summarizeHistory(await readHistory(directory), start);
  assert.equal(summary.completedTotal, 1);
  assert.equal(summary.failedTotal, 1);
}));

test('security challenges stop without retry, even when one slot remains', async () => fixture(async directory => {
  let reads = 0;
  const adapter = { async readName() { reads++; throw new WorkflowError('authentication-required'); } };
  await runCycle({ directory, adapter, now: start });
  assert.equal((await runCycle({ directory, adapter, now: start + 60000 })).reason, 'manual-attention');
  assert.equal(reads, 1);
}));

test('recovery shares budget, waits after two failures and counts completed cycle once', async () => fixture(async directory => {
  const cycle = { ...createCycle('Original'), temporaryVerified: true, phase: 'temporary-verified' };
  await writeJson(path.join(directory, 'pending-cycle.json'), cycle);
  let name = 'Original.', fail = true, reads = 0;
  const adapter = {
    async readName() { reads++; return name; },
    async saveName(expected, next) { if (fail) throw new WorkflowError('offline', true); assert.equal(name, expected); name = next; }
  };
  await runCycle({ directory, adapter, now: start, recoverOnly: true });
  await runCycle({ directory, adapter, now: start + 61000, recoverOnly: true });
  const previousReads = reads;
  assert.equal((await runCycle({ directory, adapter, now: start + 120000, recoverOnly: true })).outcome, 'skipped');
  assert.equal(reads, previousReads);
  fail = false;
  await runCycle({ directory, adapter, now: start + 3600000, recoverOnly: true });
  assert.equal(name, 'Original');
  assert.equal(summarizeHistory(await readHistory(directory), start).completedTotal, 1);
  // Simulate a crash after finalization records but before removing journal.
  await writeJson(path.join(directory, 'pending-cycle.json'), { ...cycle, phase: 'restored' });
  await runCycle({ directory, adapter, now: start + 7200000, recoverOnly: true });
  assert.equal(summarizeHistory(await readHistory(directory), start).completedTotal, 1);
}));

test('crashed reserved attempt consumes a slot and cannot reset on restart', async () => fixture(async directory => {
  await writeJson(path.join(directory, 'budget.json'), {
    version: 1, startedAt: new Date(start).toISOString(), intervalMs: 3600000,
    cycleId: 'reserved-cycle', closed: false, blocked: false,
    attempts: [{ id: 'crashed', startedAt: new Date(start).toISOString(), action: 'cycle', outcome: 'running' }]
  });
  const adapter = { async readName() { throw new WorkflowError('offline', true); } };
  assert.equal((await runCycle({ directory, adapter, now: start + 60000 })).reason, 'retry-wait');
  await runCycle({ directory, adapter, now: start + 121000 });
  assert.equal((await readJson(path.join(directory, 'budget.json'))).attempts.length, 2);
  assert.ok((await readHistory(directory)).some(row => row.attemptId === 'crashed' && row.reason === 'process-interrupted'));
  assert.equal((await runCycle({ directory, adapter, now: start + 182000 })).outcome, 'skipped');
}));

test('Off blocks attempts and recovery without reserving budget or touching browser', async () => fixture(async directory => {
  await writeJson(path.join(directory, 'pending-cycle.json'), createCycle('Private Name'));
  const adapter = { async readName() { assert.fail('Off must not access browser'); } };
  assert.equal((await runCycle({ directory, adapter, authorize: async () => false })).reason, 'workflow-off');
  assert.equal(await readJson(path.join(directory, 'budget.json'), null), null);
  assert.ok(await readJson(path.join(directory, 'pending-cycle.json')));
}));

test('history deduplicates IDs, uses IST days and fails closed on corrupt records', async () => fixture(async directory => {
  const row = { eventId: 'one', cycleId: 'one', outcome: 'cycle-completed', at: '2026-11-22T18:31:00Z' };
  await recordHistory(directory, row);
  await recordHistory(directory, row);
  assert.equal((await readHistory(directory)).length, 1);
  assert.equal(summarizeHistory(await readHistory(directory), Date.parse('2026-11-23T00:00:00Z')).completedToday, 1);
  await fs.appendFile(path.join(directory, 'history.jsonl'), '{broken');
  await assert.rejects(readHistory(directory), /corrupt/);
  let touched = false;
  await assert.rejects(runCycle({ directory, adapter: { async readName() { touched = true; } } }));
  assert.equal(touched, false);
}));

test('90-second failure waits 60 seconds after failure across restarts and preserves window cap', async () => fixture(async directory => {
  let time = start;
  let reads = 0;
  const adapter = { async readName() { reads++; time += 90000; throw new WorkflowError('offline', true); } };
  const first = await runCycle({ directory, adapter, now: start, clock: () => time });
  assert.equal(first.nextEligibleAt, new Date(start + 150000).toISOString());
  const saved = await readJson(path.join(directory, 'budget.json'));
  assert.equal(saved.startedAt, new Date(start).toISOString());
  assert.equal(saved.attempts[0].failedAt, new Date(start + 90000).toISOString());
  assert.equal(budgetStatus(saved, start + 149999).budgetState, 'retry-wait');
  assert.equal((await runCycle({ directory, adapter, now: start + 149999 })).reason, 'retry-wait');
  assert.equal(reads, 1);
  time = start + 150000;
  assert.equal((await runCycle({ directory, adapter, now: time, clock: () => time })).budgetState, 'exhausted');
  assert.equal(reads, 2);
  assert.equal((await runCycle({ directory, adapter, now: start + 3500000 })).reason, 'exhausted');
  assert.equal(reads, 2);
}));

test('late failure still waits the full delay without shifting the hourly window', async () => fixture(async directory => {
  let time = start;
  const adapter = { async readName() { time = start + 3590000; throw new WorkflowError('offline', true); } };
  const first = await runCycle({ directory, adapter, now: start, clock: () => time });
  assert.equal(first.nextEligibleAt, new Date(start + 3650000).toISOString());
  assert.equal((await runCycle({ directory, adapter, now: start + 3600000 })).reason, 'retry-wait');
  assert.equal((await readJson(path.join(directory, 'budget.json'))).startedAt, new Date(start).toISOString());
}));

test('legacy failure timestamps migrate once and cannot shorten or reset delay', async () => fixture(async directory => {
  await writeJson(path.join(directory, 'budget.json'), {
    version: 1, startedAt: new Date(start).toISOString(), intervalMs: 3600000,
    cycleId: 'legacy', closed: false, blocked: false,
    attempts: [{ id: 'legacy-failure', startedAt: new Date(start).toISOString(), action: 'cycle', outcome: 'failed' }]
  });
  const adapter = { async readName() { assert.fail('Retry must wait'); } };
  const first = await runCycle({ directory, adapter, now: start + 90000, clock: () => start + 90000 });
  assert.equal(first.reason, 'retry-wait');
  assert.equal(first.nextEligibleAt, new Date(start + 150000).toISOString());
  const second = await runCycle({ directory, adapter, now: start + 100000 });
  assert.equal(second.nextEligibleAt, first.nextEligibleAt);
  const budget = await readJson(path.join(directory, 'budget.json'));
  budget.attempts[0].failedAt = 'invalid';
  assert.throws(() => validateBudget(budget));
  budget.attempts[0].failedAt = new Date(start - 1).toISOString();
  assert.throws(() => validateBudget(budget));
}));
