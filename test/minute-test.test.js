import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runMinuteTest } from '../src/minute-test.js';
import { runCycle } from '../src/cycle.js';
import { readJson, writeJson, validate } from '../src/core.js';
import { validateBudget } from '../src/budget.js';
import { WorkflowError } from '../src/errors.js';

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minute-test-'));
  const directory = path.join(root, '.local'); await fs.mkdir(directory);
  const config = { enabled: false, permissionConfirmed: true, minimumIntervalMinutes: 60, timeoutMs: 1000,
    profileUrl: 'https://www.naukri.com/mnjuser/profile', confirmationMode: 'persisted-editor', postSaveDelayMs: 5000,
    selectors: { edit: '#edit', editor: '#editor', name: '#name', close: '.close', save: '#save' } };
  await writeJson(path.join(root, 'config.local.json'), config);
  let time = Date.parse('2026-11-23T08:00:00Z');
  const model = { name: 'Original', reads: 0, saves: [], pauses: [] };
  const adapter = () => ({ readName: async () => { model.reads++; return model.name; },
    saveName: async (expected, next) => { assert.equal(model.name, expected); model.name = next; model.saves.push(next); }, close: async () => {} });
  const options = { root, directory, createAdapter: adapter, now: () => time,
    pause: async ms => { model.pauses.push(ms); time += ms; } };
  try { await fn({ root, directory, config, model, options, adapter, advance: ms => { time += ms; } }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('minute test runs exactly two cycles one minute apart without changing normal config or budget', async () => fixture(async ({ root, directory, config, model, options }) => {
  const normal = { version: 1, startedAt: new Date(options.now()).toISOString(), intervalMs: 3600000, cycleId: 'normal-cycle', closed: true, blocked: false,
    attempts: [{ id: 'normal-attempt', startedAt: new Date(options.now()).toISOString(), action: 'cycle', outcome: 'success' }] };
  await writeJson(path.join(directory, 'budget.json'), normal);
  const result = await runMinuteTest(options);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(model.saves, ['Original.', 'Original', 'Original.', 'Original']);
  assert.deepEqual(model.pauses, [60000]);
  assert.deepEqual(await readJson(path.join(root, 'config.local.json')), config);
  assert.deepEqual(await readJson(path.join(directory, 'budget.json')), normal);
  const session = await readJson(path.join(directory, 'minute-test.json'));
  assert.equal(session.cyclesStarted, 2); assert.equal(session.cyclesCompleted, 2); assert.equal(session.status, 'completed');
  assert.equal((await readJson(path.join(directory, 'minute-test-budget.json'))).intervalMs, 60000);
}));

test('short intervals remain forbidden for normal configuration and normal cycles', async () => fixture(async ({ directory, config, adapter }) => {
  assert.throws(() => validate({ ...config, minimumIntervalMinutes: 1 }), /60/);
  await assert.rejects(runCycle({ directory, adapter: adapter(), minimumIntervalMinutes: 1 }), /60/);
  assert.throws(() => validateBudget({ version: 1, intervalMs: 60000 }), /budget/);
}));

test('test stops at its first failure without using a second attempt or starting a second cycle', async () => fixture(async ({ directory, model, options }) => {
  options.createAdapter = () => ({ readName: async () => { model.reads++; throw new WorkflowError('offline', true); }, close: async () => {} });
  assert.equal((await runMinuteTest(options)).outcome, 'failed');
  assert.equal(model.reads, 1); assert.deepEqual(model.pauses, []);
  assert.equal((await readJson(path.join(directory, 'minute-test.json'))).cyclesStarted, 1);
  assert.equal((await readJson(path.join(directory, 'minute-test-budget.json'))).attempts.length, 1);
}));

test('stop during the minute wait prevents a second cycle', async () => fixture(async ({ model, options }) => {
  let stopped = false;
  options.pause = async () => { stopped = true; };
  options.stopped = () => stopped;
  assert.equal((await runMinuteTest(options)).outcome, 'stopped');
  assert.equal(model.saves.length, 2); assert.equal(model.name, 'Original');
}));

test('normal operation waits an hour after the latest test attempt', async () => fixture(async ({ directory, model, options, adapter, advance }) => {
  await runMinuteTest(options);
  const before = model.reads;
  const early = await runCycle({ directory, adapter: adapter(), now: options.now() });
  assert.equal(early.reason, 'minimum-interval-after-test'); assert.equal(model.reads, before);
  advance(3600000);
  assert.equal((await runCycle({ directory, adapter: adapter(), now: options.now() })).outcome, 'restored');
}));

test('expired or exhausted test sessions cannot reserve more attempts', async () => fixture(async ({ directory, model, options, adapter, advance }) => {
  await runMinuteTest(options);
  const session = await readJson(path.join(directory, 'minute-test.json'));
  const before = model.reads;
  const third = await runCycle({ directory, adapter: adapter(), now: options.now(), minimumIntervalMinutes: 1, minuteTestSessionId: session.id });
  assert.equal(third.reason, 'minute-test-ended'); assert.equal(model.reads, before);
  advance(300001);
  assert.equal((await runCycle({ directory, adapter: adapter(), now: options.now(), minimumIntervalMinutes: 1, minuteTestSessionId: session.id })).reason, 'minute-test-ended');
}));

test('failed minute test allows restoration during the post-test cooldown', async () => fixture(async ({ directory, model, options, adapter }) => {
  options.createAdapter = () => ({ ...adapter(), async saveName(expected, next) {
    assert.equal(model.name, expected);
    model.name = next;
    throw new WorkflowError('save-unconfirmed', true);
  } });
  assert.equal((await runMinuteTest(options)).outcome, 'failed');
  assert.equal(model.name, 'Original.');
  const result = await runCycle({ directory, adapter: adapter(), now: options.now(), recoverOnly: true });
  assert.equal(result.outcome, 'restored');
  assert.deepEqual(model.saves, ['Original']);
  assert.equal((await runCycle({ directory, adapter: adapter(), now: options.now() })).reason, 'minimum-interval-after-test');
}));
