import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCycle, phases, recoveryDecision, publicCycleStatus, runCycle } from '../src/cycle.js';
import { readJson, writeJson, acquireLock } from '../src/core.js';
import { WorkflowError } from '../src/errors.js';

async function fixture(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-cycle-'));
  try { await fn(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function browser(initial) {
  return {
    name: initial, writes: [], reads: 0,
    async readName() { this.reads++; return this.name; },
    async saveName(expected, next) { assert.equal(this.name, expected); this.writes.push(next); this.name = next; }
  };
}

test('a new Windows session starts one fresh cycle and anchors the next hour', async () => fixture(async directory => {
  const adapter = browser('Original');
  const start = Date.now();
  assert.equal((await runCycle({ directory, adapter, now: start })).outcome, 'restored');
  const wake = start + 600000;
  assert.equal((await runCycle({ directory, adapter, now: wake + 100, sessionStartedAt: wake })).outcome, 'restored');
  const repeated = await runCycle({ directory, adapter, now: wake + 1000, sessionStartedAt: wake });
  assert.equal(repeated.outcome, 'skipped');
  assert.equal(Date.parse(repeated.nextEligibleAt), wake + 100 + 3600000);
  assert.equal(adapter.writes.length, 4);
}));

test('an editor change before Save gets one delayed retry and never writes the profile', async () => fixture(async directory => {
  const adapter = browser('Original');
  adapter.saveName = async () => { throw new WorkflowError('other-fields-changed'); };
  const start = Date.now();
  const first = await runCycle({ directory, adapter, now: start });
  assert.equal(first.retryable, true);
  const retry = Date.parse(first.nextEligibleAt);
  assert.equal((await runCycle({ directory, adapter, now: retry - 1 })).reason, 'retry-wait');
  assert.equal((await runCycle({ directory, adapter, now: retry })).budgetState, 'exhausted');
  assert.equal((await runCycle({ directory, adapter, now: retry + 1000 })).reason, 'exhausted');
  assert.equal(await readJson(path.join(directory, 'pending-cycle.json'), null), null);
  assert.deepEqual(adapter.writes, []);
}));

test('a new Windows session restarts a legacy pre-save failure without replaying its unused journal', async () => fixture(async directory => {
  const adapter = browser('Original');
  const start = Date.now();
  const first = await runCycle({ directory, now: start, adapter: {
    ...adapter, saveName: async () => { throw new WorkflowError('other-fields-changed'); }
  } });
  const file = path.join(directory, 'budget.json');
  const budget = await readJson(file);
  await writeJson(file, { ...budget, blocked: true });
  await writeJson(path.join(directory, 'pending-cycle.json'), { ...createCycle('Original'), id: budget.cycleId, phase: 'temporary-submit-intent' });
  const retryAt = Date.parse(first.nextEligibleAt);
  const wake = retryAt - 1000;
  const early = await runCycle({ directory, adapter, now: wake, sessionStartedAt: wake });
  assert.equal(early.reason, 'retry-wait');
  assert.equal(Date.parse(early.nextEligibleAt), retryAt);
  assert.equal((await runCycle({ directory, adapter, now: retryAt, sessionStartedAt: wake })).outcome, 'restored');
  assert.deepEqual(adapter.writes, ['Original.', 'Original']);
  assert.equal((await readJson(file)).attempts.length, 1);
  assert.equal((await runCycle({ directory, adapter, now: retryAt + 1000, sessionStartedAt: wake })).outcome, 'skipped');
}));

for (const evidence of ['legacy history', 'budget after interrupted history write']) {
test(`manual recovery discards a proven unused journal using ${evidence}`, async () => fixture(async directory => {
  const adapter = browser('Original');
  const start = Date.now();
  const failed = await runCycle({ directory, now: start, adapter: {
    ...adapter, saveName: async () => { throw new WorkflowError('other-fields-changed'); }
  } });
  const budgetFile = path.join(directory, 'budget.json');
  const budget = await readJson(budgetFile);
  const attempt = budget.attempts.at(-1);
  if (evidence === 'legacy history') {
    delete attempt.stoppedBeforeSave;
    await writeJson(budgetFile, budget);
  } else {
    assert.equal(attempt.stoppedBeforeSave, true);
    const historyFile = path.join(directory, 'history.jsonl');
    const history = await fs.readFile(historyFile, 'utf8');
    await fs.writeFile(historyFile, history.replace(/[^\r\n]+:failed[^\r\n]*\r?\n/g, ''));
    assert.doesNotMatch(await fs.readFile(historyFile, 'utf8'), /:failed/);
  }
  const journal = path.join(directory, 'pending-cycle.json');
  await writeJson(journal, { ...createCycle('Original'), id: budget.cycleId, phase: 'temporary-submit-intent' });
  adapter.name = 'Original.';
  const reads = adapter.reads;
  const result = await runCycle({ directory, adapter, recoverOnly: true, now: Date.parse(failed.nextEligibleAt) });
  assert.deepEqual(result, { outcome: 'nothing-to-recover', reason: 'no-save-was-sent' });
  assert.equal(adapter.reads, reads);
  assert.equal(adapter.name, 'Original.');
  assert.deepEqual(adapter.writes, []);
  assert.equal(await readJson(journal, null), null);
}));
}

test('names preserve punctuation, Unicode and whitespace exactly', () => {
  for (const name of ['Alex', 'Alex.', '  Renée 王.  ']) {
    const cycle = createCycle(name);
    assert.equal(cycle.originalName, name);
    assert.equal(cycle.temporaryName, name + '.');
  }
  for (const name of ['', '   ', null, 42]) assert.throws(() => createCycle(name));
});

test('all phases reconcile original, temporary and conflicting names conservatively', () => {
  for (const phase of phases) {
    const cycle = { ...createCycle('Original'), phase };
    assert.equal(recoveryDecision(cycle, 'Original'), 'complete');
    assert.equal(recoveryDecision(cycle, 'Original.'), 'restore');
    assert.equal(recoveryDecision(cycle, 'User edited'), 'conflict');
  }
  assert.throws(() => recoveryDecision({ ...createCycle('Name'), temporaryName: 'Wrong' }, 'Name'));
  assert.throws(() => publicCycleStatus({}));
  assert.ok(!JSON.stringify(publicCycleStatus(createCycle('Private Name'))).includes('Private Name'));
});

test('full cycle journals intent before each write, restores exactly, then enforces cooldown', async () => fixture(async directory => {
  const adapter = browser('  Original. ');
  const save = adapter.saveName.bind(adapter);
  adapter.saveName = async (expected, next) => {
    const journal = await readJson(path.join(directory, 'pending-cycle.json'));
    assert.equal(journal.phase, adapter.writes.length === 0 ? 'temporary-submit-intent' : 'restore-submit-intent');
    assert.equal(journal.originalName, '  Original. ');
    await save(expected, next);
  };
  assert.equal((await runCycle({ directory, adapter })).outcome, 'restored');
  assert.deepEqual(adapter.writes, ['  Original. .', '  Original. ']);
  assert.equal(adapter.name, '  Original. ');
  assert.equal(await readJson(path.join(directory, 'pending-cycle.json'), null), null);
  const reads = adapter.reads;
  assert.equal((await runCycle({ directory, adapter })).outcome, 'skipped');
  assert.equal(adapter.reads, reads);
}));

for (const failure of ['before-first-save', 'after-first-save', 'before-restore', 'after-restore']) {
  test(`recovers interruption ${failure} without another temporary edit`, async () => fixture(async directory => {
    const adapter = browser('Original');
    const save = adapter.saveName.bind(adapter);
    let calls = 0;
    adapter.saveName = async (expected, next) => {
      calls++;
      const target = failure.includes('first') ? 1 : 2;
      if (calls === target && failure.startsWith('before')) throw new WorkflowError('network-failure', true);
      await save(expected, next);
      if (calls === target && failure.startsWith('after')) throw new WorkflowError('save-unconfirmed', true);
    };
    const start = Date.now();
    const first = await runCycle({ directory, adapter, now: start });
    assert.equal(first.outcome, 'failed');
    assert.ok(await readJson(path.join(directory, 'pending-cycle.json')));
    adapter.saveName = save;
    assert.equal((await runCycle({ directory, adapter, now: Date.parse(first.nextEligibleAt) })).outcome, 'restored');
    assert.equal(adapter.name, 'Original');
    assert.ok(adapter.writes.filter(value => value === 'Original.').length <= 1);
  }));
}

test('conflicting user edits are never overwritten and journal is retained', async () => fixture(async directory => {
  const journal = { ...createCycle('Original'), phase: 'temporary-submit-intent' };
  await writeJson(path.join(directory, 'pending-cycle.json'), journal);
  const adapter = browser('User edited');
  assert.equal((await runCycle({ directory, adapter })).outcome, 'failed');
  assert.deepEqual(adapter.writes, []);
  assert.deepEqual(await readJson(path.join(directory, 'pending-cycle.json')), journal);
  const state = await readJson(path.join(directory, 'state.json'));
  assert.ok(!JSON.stringify(state).includes('User edited'));
}));

test('challenge or unavailable page retains recovery and does not bypass it', async () => fixture(async directory => {
  await writeJson(path.join(directory, 'pending-cycle.json'), createCycle('Original'));
  const adapter = { async readName() { throw new Error('Sensitive name in upstream error'); }, async saveName() { assert.fail('No write expected'); } };
  assert.equal((await runCycle({ directory, adapter })).outcome, 'failed');
  assert.ok(await readJson(path.join(directory, 'pending-cycle.json')));
  assert.ok(!JSON.stringify(await readJson(path.join(directory, 'state.json'))).includes('Sensitive name'));
}));

test('recover-only is a no-op without journal, and locks reject concurrent work', async () => fixture(async directory => {
  const adapter = browser('Original');
  assert.equal((await runCycle({ directory, adapter, recoverOnly: true })).outcome, 'nothing-to-recover');
  assert.equal(adapter.reads, 0);
  const release = await acquireLock(directory);
  await assert.rejects(runCycle({ directory, adapter }), { code: 'EEXIST' });
  assert.equal(adapter.reads, 0);
  await release();
}));

test('corrupt journals fail closed without browser access', async () => fixture(async directory => {
  await fs.writeFile(path.join(directory, 'pending-cycle.json'), '{broken');
  const adapter = browser('Original');
  await assert.rejects(runCycle({ directory, adapter }));
  assert.equal(adapter.reads, 0);
  assert.equal(await fs.readFile(path.join(directory, 'pending-cycle.json'), 'utf8'), '{broken');
}));
