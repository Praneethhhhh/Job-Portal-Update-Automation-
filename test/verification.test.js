import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, readJson, writeJson } from '../src/core.js';
import { createCycle } from '../src/cycle.js';
import { WorkflowError } from '../src/errors.js';
import { checkSetup, configurationId, readVerification, verificationStatus, verifyDryRun, verifyCycle } from '../src/verification.js';

async function fixture(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-'));
  const config = { profileUrl: 'https://www.naukri.com/mnjuser/profile?private=query',
    browserChannel: 'msedge', minimumIntervalMinutes: 60, timeoutMs: 1000, headless: true,
    enabled: true, permissionConfirmed: true,
    selectors: { edit: '#edit', editor: '#editor', name: '#name', close: '.close', save: '.save', success: '#success', challenge: '#challenge', validationError: '#validation' } };
  const adapter = { name: 'Private Name', saves: 0, reads: 0, closes: 0,
    async dryRun() { return { outcome: 'dry-run-passed', privateName: this.name }; },
    async readName() { this.reads++; return this.name; },
    async saveName(expected, next) { assert.equal(this.name, expected); this.name = next; this.saves++; },
    async close() { this.closes++; }
  };
  const options = { directory, config, adapter, readConfig: async () => config };
  const dryRuns = async () => {
    await verifyDryRun(options);
    await verifyDryRun({ ...options, background: true });
  };
  try { await fn({ directory, config, adapter, options, dryRuns }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('dry-run evidence is redacted and does not reserve budget or write profile', async () => fixture(async ({ directory, config, adapter, options, dryRuns }) => {
  config.enabled = false;
  config.permissionConfirmed = false;
  await dryRuns();
  const report = await readVerification(directory);
  assert.equal(verificationStatus(report, config).visibleDryRun, 'passed');
  assert.equal(verificationStatus(report, config).backgroundDryRun, 'passed');
  assert.equal(verificationStatus(report, config).liveChecksPassed, false);
  assert.equal(adapter.saves, 0);
  assert.equal(adapter.reads, 0);
  assert.equal(adapter.closes, 2);
  assert.equal(await readJson(path.join(directory, 'budget.json'), null), null);
  const raw = JSON.stringify(report);
  for (const privateValue of ['Private Name', 'private=query', '#editor']) assert.ok(!raw.includes(privateValue));
  assert.equal((await verifyDryRun(options)).outcome, 'passed');
}));

test('changed controls invalidate evidence; activation and selector property order do not', async () => fixture(async ({ directory, config, dryRuns }) => {
  await dryRuns();
  const report = await readVerification(directory);
  const reordered = { ...config, enabled: false, permissionConfirmed: false, headless: false,
    selectors: Object.fromEntries(Object.entries(config.selectors).reverse()) };
  assert.equal(configurationId(config), configurationId(reordered));
  for (const changed of [{ ...config, browserChannel: 'chrome' }, { ...config, timeoutMs: 2000 },
    { ...config, selectors: { ...config.selectors, name: '#new-name' } }]) {
    assert.equal(verificationStatus(report, changed).visibleDryRun, 'not-verified');
    assert.equal(verificationStatus(report, changed).liveChecksPassed, false);
  }
}));

test('failed checks replace stale success without saving raw exceptions', async () => fixture(async ({ directory, adapter, options, dryRuns }) => {
  await dryRuns();
  adapter.dryRun = async () => { throw new Error('Private Name and cookie secret'); };
  assert.equal((await verifyDryRun(options)).outcome, 'failed');
  const report = await readVerification(directory);
  assert.equal(report.checks.visibleDryRun.status, 'failed');
  assert.ok(!JSON.stringify(report).includes('secret'));
}));

test('configuration changed during dry-run cannot pass', async () => fixture(async ({ config, options }) => {
  const result = await verifyDryRun({ ...options, readConfig: async () => ({ ...config, timeoutMs: 2000 }) });
  assert.equal(result.outcome, 'failed');
}));

test('live save requires the configured dry-run and strict boolean activation', async () => fixture(async ({ directory, config, adapter, options, dryRuns }) => {
  assert.equal((await verifyCycle(options)).reason, 'complete-configured-dry-run-first');
  assert.equal(adapter.reads, 0);
  assert.equal(await readJson(path.join(directory, 'budget.json'), null), null);
  await dryRuns();
  for (const invalid of [{ ...config, enabled: false }, { ...config, permissionConfirmed: 'true' }]) {
    await assert.rejects(verifyCycle({ ...options, config: invalid }), /Saving requires/);
  }
  assert.equal(adapter.saves, 0);
}));

test('full supervised cycle passes once; cooldown skip preserves its evidence', async () => fixture(async ({ directory, config, adapter, options, dryRuns }) => {
  await dryRuns();
  assert.equal((await verifyCycle(options)).liveChecksPassed, true);
  assert.equal(adapter.name, 'Private Name');
  assert.equal(adapter.saves, 2);
  assert.equal((await readJson(path.join(directory, 'budget.json'))).attempts.length, 1);
  assert.equal((await verifyCycle(options)).outcome, 'skipped');
  assert.equal(adapter.saves, 2);
  assert.equal(verificationStatus(await readVerification(directory), config).liveChecksPassed, true);
  await verifyDryRun(options);
  assert.equal(verificationStatus(await readVerification(directory), config).liveChecksPassed, true);
  await verifyDryRun({ ...options, background: true });
  assert.equal(verificationStatus(await readVerification(directory), config).liveChecksPassed, false);
}));

test('visible validation succeeds even when the hidden browser check fails', async () => fixture(async ({ config, options }) => {
  config.headless = false;
  await verifyDryRun({ ...options, background: true, adapter: { dryRun: async () => { throw new Error('Forbidden'); }, close: async () => {} } });
  await verifyDryRun(options);
  const result = await verifyCycle(options);
  assert.equal(result.backgroundDryRun, 'failed');
  assert.equal(result.liveChecksPassed, true);
}));

test('transient supervised failure uses one attempt and retains recovery without auto retry', async () => fixture(async ({ directory, adapter, options, dryRuns }) => {
  await dryRuns();
  adapter.saveName = async () => { adapter.saves++; throw new WorkflowError('offline', true); };
  assert.equal((await verifyCycle(options)).outcome, 'failed');
  assert.equal(adapter.saves, 1);
  assert.equal((await readJson(path.join(directory, 'budget.json'))).attempts.length, 1);
  assert.ok(await readJson(path.join(directory, 'pending-cycle.json')));
  assert.equal((await readVerification(directory)).checks.supervisedCycle.status, 'failed');
}));

test('restoring an existing verified journal cannot certify a fresh two-save cycle', async () => fixture(async ({ directory, adapter, options, dryRuns }) => {
  await dryRuns();
  await writeJson(path.join(directory, 'pending-cycle.json'), { ...createCycle('Private Name'), phase: 'temporary-verified', temporaryVerified: true });
  adapter.name = 'Private Name.';
  assert.equal((await verifyCycle(options)).outcome, 'failed');
  assert.equal(adapter.name, 'Private Name');
  assert.equal(adapter.saves, 1);
}));

test('turning Off after preflight prevents a validation attempt', async () => fixture(async ({ directory, config, adapter, options, dryRuns }) => {
  await dryRuns();
  assert.equal((await verifyCycle({ ...options, readConfig: async () => ({ ...config, enabled: false }) })).outcome, 'skipped');
  assert.equal(adapter.saves, 0);
  assert.equal(adapter.reads, 0);
  assert.equal(await readJson(path.join(directory, 'budget.json'), null), null);
}));

test('dry-run respects the browser lock and corrupt evidence fails before browser access', async () => fixture(async ({ directory, adapter, options }) => {
  let accessed = false;
  adapter.dryRun = async () => { accessed = true; };
  const release = await acquireLock(directory);
  try { await assert.rejects(verifyDryRun(options), { code: 'EEXIST' }); }
  finally { await release(); }
  await fs.writeFile(path.join(directory, 'validation.json'), '{broken');
  await assert.rejects(verifyDryRun(options));
  assert.equal(accessed, false);
  assert.equal(await readJson(path.join(directory, 'run.lock'), null), null);
}));

test('setup diagnoses missing configuration and corrupt state without resetting files', async () => fixture(async ({ directory }) => {
  const missing = await checkSetup({ root: directory, directory });
  assert.equal(missing.checks.find(row => row.check === 'configuration').status, 'needs-attention');
  await fs.writeFile(path.join(directory, 'pending-cycle.json'), '{private-corruption');
  const result = await checkSetup({ root: directory, directory });
  assert.equal(result.localStateValid, false);
  assert.ok(!JSON.stringify(result).includes('private-corruption'));
  assert.equal(await fs.readFile(path.join(directory, 'pending-cycle.json'), 'utf8'), '{private-corruption');
}));
