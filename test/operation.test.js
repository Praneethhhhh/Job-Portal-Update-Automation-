import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, acquireLock } from '../src/core.js';
import { createCycle } from '../src/cycle.js';
import { configurationId } from '../src/verification.js';
import { automationReadiness, operationStatus } from '../src/operation.js';
import { runScheduledTick, acquireRunnerLock } from '../src/scheduler.js';
import { startDashboard } from '../src/dashboard.js';
import { WorkflowError } from '../src/errors.js';
import { chromium } from 'playwright';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const start = Date.parse('2026-11-23T04:50:00Z');
const taskStatus = async () => ({ state: 'not-installed', running: false });
async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operation-test-'));
  const directory = path.join(root, '.local');
  await fs.mkdir(directory);
  await fs.cp(path.join(sourceRoot, 'web'), path.join(root, 'web'), { recursive: true });
  const config = { profileUrl: 'https://www.naukri.com/mnjuser/profile', minimumIntervalMinutes: 60,
    timeoutMs: 1000, headless: true, enabled: false, permissionConfirmed: true, unattendedConfirmed: true,
    selectors: { edit: '#edit', editor: '#editor', name: '#name', close: '.close', save: '.save', success: '#success', challenge: '#challenge', validationError: '#validation' } };
  const configFile = path.join(root, 'config.local.json');
  const saveConfig = async changes => { Object.assign(config, changes); await writeJson(configFile, config); };
  await saveConfig({});
  await writeJson(path.join(directory, 'validation.json'), { version: 1, checks: Object.fromEntries(['visibleDryRun', 'backgroundDryRun', 'supervisedCycle'].map(kind => [kind, { configurationId: configurationId(config), status: 'passed', at: new Date(start).toISOString(), ...(kind === 'supervisedCycle' ? { headless: true } : {}) }])) });
  const model = { name: 'Private Name', reads: 0, saves: [], closes: 0 };
  const createAdapter = () => ({
    async readName() { model.reads++; return model.name; },
    async saveName(expected, next) { assert.equal(model.name, expected); model.name = next; model.saves.push(next); },
    async close() { model.closes++; }
  });
  const options = { root, directory, createAdapter, now: start };
  try { await fn({ root, directory, config, configFile, saveConfig, model, options }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      let raw = '';
      res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
      res.on('end', () => { let data; try { data = JSON.parse(raw); } catch { data = raw; } resolve({ status: res.statusCode, headers: res.headers, data }); });
    });
    req.on('error', reject); req.end(body);
  });
}

test('automation requires valid configuration and explicit site permission', async () => fixture(async ({ directory, config }) => {
  assert.equal((await automationReadiness(directory, config)).ready, true);
  for (const invalid of [{ ...config, permissionConfirmed: false }, { ...config, timeoutMs: 0 }, { ...config, headless: false }, { ...config, timeoutMs: 2000 }]) {
    assert.equal((await automationReadiness(directory, invalid)).ready, false);
  }
}));

test('scheduler reclaims runner and workflow locks left by an exited process', async () => fixture(async ({ directory, options, saveConfig }) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await once(child, 'exit');
  const runner = path.join(directory, 'runner');
  await fs.mkdir(runner);
  for (const folder of [directory, runner]) await writeJson(path.join(folder, 'run.lock'), { pid: child.pid });
  const release = await acquireRunnerLock(directory);
  try {
    await saveConfig({ enabled: true });
    assert.equal((await runScheduledTick(options)).outcome, 'restored');
  } finally { await release(); }
}));

test('Off prevents reservation; cooldown and sleep/resume do not replay missed hours', async () => fixture(async ({ directory, options, model, saveConfig }) => {
  assert.equal((await runScheduledTick(options)).reason, 'workflow-off');
  assert.equal(model.reads, 0);
  assert.equal(await readJson(path.join(directory, 'budget.json'), null), null);
  await saveConfig({ enabled: true });
  assert.equal((await runScheduledTick(options)).outcome, 'restored');
  assert.equal(model.saves.length, 2);
  assert.equal((await runScheduledTick({ ...options, now: start + 1800000 })).outcome, 'skipped');
  assert.equal(model.saves.length, 2);
  assert.equal((await runScheduledTick({ ...options, now: start + 10 * 3600000 })).outcome, 'restored');
  assert.equal(model.saves.length, 4);
  assert.equal((await runScheduledTick({ ...options, now: start + 10 * 3600000 + 15000 })).outcome, 'skipped');
  assert.equal(model.saves.length, 4);
}));

test('scheduled recovery restores only, and turning Off cancels a waiting retry', async () => fixture(async ({ directory, options, model, saveConfig }) => {
  await saveConfig({ enabled: true });
  await writeJson(path.join(directory, 'pending-cycle.json'), { ...createCycle('Private Name'), phase: 'temporary-submit-intent' });
  model.name = 'Private Name.';
  assert.equal((await runScheduledTick(options)).outcome, 'restored');
  assert.deepEqual(model.saves, ['Private Name']);
  assert.equal((await operationStatus({ ...options, taskStatus, now: start })).completedTotal, 0);
  const failOptions = { ...options, now: start + 3600000, createAdapter: () => ({ readName: async () => { model.reads++; throw new WorkflowError('offline', true); }, close: async () => {} }) };
  assert.equal((await runScheduledTick(failOptions)).outcome, 'failed');
  await saveConfig({ enabled: false });
  const before = model.reads;
  assert.equal((await runScheduledTick({ ...failOptions, now: start + 3661000 })).reason, 'workflow-off');
  assert.equal(model.reads, before);
  assert.equal((await readJson(path.join(directory, 'budget.json'))).attempts.length, 1);
}));

test('scheduled transient failures get one delayed retry and no third attempt', async () => fixture(async ({ directory, options, saveConfig }) => {
  await saveConfig({ enabled: true });
  let reads = 0;
  const failing = { ...options, createAdapter: () => ({ readName: async () => { reads++; throw new WorkflowError('offline', true); }, close: async () => {} }) };
  assert.equal((await runScheduledTick(failing)).outcome, 'failed');
  assert.equal((await runScheduledTick({ ...failing, now: start + 59000 })).outcome, 'skipped');
  assert.equal((await runScheduledTick({ ...failing, now: start + 61000 })).outcome, 'failed');
  assert.equal((await runScheduledTick({ ...failing, now: start + 120000 })).outcome, 'skipped');
  assert.equal(reads, 2);
  assert.equal((await readJson(path.join(directory, 'budget.json'))).attempts.length, 2);
}));

test('sign-in and wake each start a fresh cycle and the next interval is persisted at second precision', async () => fixture(async ({ directory, options, model, saveConfig }) => {
  await saveConfig({ enabled: true });
  const marker = path.join(directory, 'windows-session.json');
  for (const now of [start, start + 600000]) {
    await writeJson(marker, { at: new Date(now).toISOString() });
    assert.equal((await runScheduledTick({ ...options, now })).outcome, 'restored');
    const budget = await readJson(path.join(directory, 'budget.json'));
    assert.ok(budget.intervalMs >= 2100000 && budget.intervalMs <= 2700000);
    assert.equal(budget.intervalMs % 1000, 0);
    const early = await runScheduledTick({ ...options, now: now + budget.intervalMs - 1000 });
    assert.equal(early.outcome, 'skipped');
    assert.equal(Date.parse(early.nextEligibleAt), now + budget.intervalMs);
    assert.deepEqual(await readJson(path.join(directory, 'budget.json')), budget);
  }
  assert.equal(model.saves.length, 4);
  const budget = await readJson(path.join(directory, 'budget.json'));
  assert.equal((await runScheduledTick({ ...options, now: Date.parse(budget.startedAt) + budget.intervalMs })).outcome, 'restored');
  assert.equal(model.saves.length, 6);
}));

test('Off saved during the Windows check prevents an attempt from being reserved', async () => fixture(async ({ directory, options, model, saveConfig }) => {
  await saveConfig({ enabled: true });
  const result = await runScheduledTick({ ...options, canRun: async () => {
    await saveConfig({ enabled: false });
    return true;
  } });
  assert.equal(result.reason, 'workflow-off');
  assert.equal(model.reads, 0);
  assert.equal(await readJson(path.join(directory, 'budget.json'), null), null);
}));

test('a delayed worker handles a sign-in or wake signal once', async () => fixture(async ({ directory, options, model, saveConfig }) => {
  await saveConfig({ enabled: true });
  assert.equal((await runScheduledTick(options)).outcome, 'restored');
  await writeJson(path.join(directory, 'windows-session.json'), { at: new Date(start + 60000).toISOString() });
  const delayed = start + 6 * 60000;
  assert.equal((await runScheduledTick({ ...options, now: delayed })).outcome, 'restored');
  assert.equal((await runScheduledTick({ ...options, now: delayed + 15000 })).outcome, 'skipped');
  assert.equal(model.saves.length, 4);
}));

test('runner lock and workflow lock prevent overlapping browser work', async () => fixture(async ({ directory, options, model, saveConfig }) => {
  const releaseRunner = await acquireRunnerLock(directory);
  try { await assert.rejects(acquireRunnerLock(directory), { code: 'EEXIST' }); }
  finally { await releaseRunner(); }
  await saveConfig({ enabled: true });
  const release = await acquireLock(directory);
  try { assert.equal((await runScheduledTick(options)).reason, 'already-running'); }
  finally { await release(); }
  assert.equal(model.reads, 0);
}));

test('scheduled browser closes while the workflow lock is still held', async () => fixture(async ({ directory, options, saveConfig }) => {
  await saveConfig({ enabled: true });
  let closeUnderLock = false;
  const original = options.createAdapter;
  options.createAdapter = () => ({ ...original(), async close() {
    const lock = await readJson(path.join(directory, 'run.lock'), null);
    closeUnderLock ||= lock !== null;
  } });
  assert.equal((await runScheduledTick(options)).outcome, 'restored');
  assert.equal(closeUnderLock, true);
}));

test('a paused/unknown scheduler at reservation prevents a new attempt', async () => fixture(async ({ directory, options, model, saveConfig }) => {
  await saveConfig({ enabled: true });
  assert.equal((await runScheduledTick({ ...options, canRun: async () => false })).reason, 'workflow-off');
  assert.equal(model.reads, 0);
  assert.equal(await readJson(path.join(directory, 'budget.json'), null), null);
}));

test('dashboard protects Host, Origin and CSRF, validates payloads, and keeps private values out of status', async () => fixture(async ({ root, directory, saveConfig, configFile }) => {
  await saveConfig({ privateValue: 'do-not-display', enabled: true });
  await writeJson(path.join(directory, 'pending-cycle.json'), createCycle('Private Name'));
  const dashboard = await startDashboard({ root, directory, port: 0, taskStatus });
  try {
    assert.equal(dashboard.server.address().address, '127.0.0.1');
    const status = await request(`${dashboard.url}/api/status`);
    assert.equal(status.status, 200);
    assert.equal(status.data.restorationRequired, true);
    assert.ok(!JSON.stringify(status.data).includes('Private Name'));
    assert.ok(!JSON.stringify(status.data).includes('do-not-display'));
    assert.equal(status.data.scheduler.state, 'not-installed');
    assert.equal((await request(`${dashboard.url}/api/status`, { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await request(`${dashboard.url}/api/status`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(`${dashboard.url}/api/status`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const headers = { Origin: dashboard.url, 'Content-Type': 'application/json', 'X-CSRF-Token': status.data.token };
    const post = (body, extra = {}) => request(`${dashboard.url}/api/activation`, { method: 'POST', headers: { ...headers, ...extra }, body });
    assert.equal((await post('{"enabled":false}', { 'X-CSRF-Token': 'bad' })).status, 403);
    assert.equal((await post('{"enabled":false}', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('{"enabled":"false"}')).status, 400);
    assert.equal((await post('{"enabled":false,"permissionConfirmed":true}')).status, 400);
    assert.equal((await post('{"enabled":true,"unattendedConfirmed":false}')).status, 400);
    assert.equal((await post('x'.repeat(5000))).status, 413);
    const release = await acquireLock(directory);
    try { assert.equal((await post('{"enabled":false}')).status, 200); }
    finally { await release(); }
    const saved = await readJson(configFile);
    assert.equal(saved.enabled, false);
    assert.equal(saved.privateValue, 'do-not-display');
    assert.ok((await request(dashboard.url)).headers['content-security-policy'].includes("frame-ancestors 'none'"));
  } finally { await dashboard.close(); }
}));

test('On is gated, persists without resetting budget, and corrupt history shows unavailable counts', async () => fixture(async ({ root, directory, saveConfig }) => {
  const dashboard = await startDashboard({ root, directory, port: 0, taskStatus });
  try {
    const status = (await request(`${dashboard.url}/api/status`)).data;
    const activate = () => request(`${dashboard.url}/api/activation`, { method: 'POST', headers: { Origin: dashboard.url, 'Content-Type': 'application/json', 'X-CSRF-Token': status.token }, body: '{"enabled":true}' });
    await saveConfig({ permissionConfirmed: false });
    assert.equal((await activate()).status, 409);
    await saveConfig({ permissionConfirmed: true });
    assert.equal((await activate()).status, 200);
    assert.equal(await readJson(path.join(directory, 'budget.json'), null), null);
    await fs.writeFile(path.join(directory, 'history.jsonl'), '{secret-corrupt-history');
    const corrupt = (await request(`${dashboard.url}/api/status`)).data;
    assert.equal(corrupt.localStateValid, false);
    assert.equal(corrupt.completedTotal, undefined);
    assert.ok(!JSON.stringify(corrupt).includes('secret-corrupt-history'));
    assert.equal((await activate()).status, 409);
  } finally { await dashboard.close(); }
}));

function activityFixture(count) {
  return Array.from({ length: count }, (_, index) => ({
    version: 1, eventId: `event-${index}`, cycleId: `cycle-${index}`,
    at: new Date(start + index * 60000).toISOString(), outcome: 'cycle-completed',
    privateField: 'Private Name ✓'.repeat(28)
  })).map(row => JSON.stringify(row)).join('\n') + '\n';
}

test('activity returns bounded pages and keeps the next cursor stable across appends', async () => fixture(async ({ root, directory }) => {
  const journal = path.join(directory, 'history.jsonl');
  await fs.writeFile(journal, activityFixture(45));
  const dashboard = await startDashboard({ root, directory, port: 0, taskStatus });
  try {
    const status = await request(`${dashboard.url}/api/status`);
    assert.equal(status.data.completedTotal, 45);
    assert.equal(status.data.activity, undefined);
    const activity = async cursor => {
      const query = cursor === undefined ? '' : `?before=${cursor}`;
      const result = await request(`${dashboard.url}/api/activity${query}`);
      assert.equal(result.status, 200);
      assert.ok(!JSON.stringify(result.data).includes('Private Name'));
      return result.data;
    };
    const first = await activity();
    assert.equal(first.records.length, 20);
    assert.equal(first.records[0].at, new Date(start + 44 * 60000).toISOString());
    await fs.appendFile(journal, activityFixture(46).trimEnd().split('\n').at(-1) + '\n');
    const second = await activity(first.next);
    assert.equal(second.records.length, 20);
    assert.equal(second.records[0].at, new Date(start + 24 * 60000).toISOString());
    const last = await activity(second.next);
    assert.equal(last.records.length, 5);
    assert.equal(last.next, null);
    assert.equal((await request(`${dashboard.url}/api/status`)).data.completedTotal, 46);
    assert.equal((await request(`${dashboard.url}/api/activity?before=1`)).status, 400);
  } finally { await dashboard.close(); }
}));

test('dashboard browser renders offline, persists On/Off, and fits desktop and mobile', async () => fixture(async ({ root, directory, configFile, saveConfig }) => {
  await saveConfig({ unattendedConfirmed: false });
  await fs.writeFile(path.join(directory, 'history.jsonl'), activityFixture(21));
  const dashboard = await startDashboard({ root, directory, port: 0, taskStatus });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const activityRequests = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/activity') activityRequests.push(request.url());
    });
    assert.equal((await page.goto(dashboard.url)).status(), 200);
    await page.getByRole('heading', { name: 'Your workflow is Off' }).waitFor();
    await page.getByRole('navigation', { name: 'Activity pages' }).waitFor();
    assert.equal(await page.locator('#activity tr').count(), 20);
    assert.deepEqual(activityRequests, [`${dashboard.url}/api/activity`]);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText('Page 2', { exact: true }).waitFor();
    assert.equal(await page.locator('#activity tr').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
    assert.match(activityRequests[1], /\?before=\d+$/);
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await page.getByText('Page 1', { exact: true }).waitFor();
    assert.equal(await page.locator('#activity tr').count(), 20);
    const toggle = page.getByRole('switch', { name: 'Enable profile workflow' });
    assert.equal(await toggle.isDisabled(), false);
    assert.equal(await page.locator('#last-outcome').innerText(), 'No runs yet');
    assert.equal(await page.locator('#scheduler').innerText(), 'Not installed');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('#activation').getAttribute('aria-checked') === 'true');
    assert.equal((await readJson(configFile)).enabled, true);
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('#activation').getAttribute('aria-checked') === 'false');
    assert.equal((await readJson(configFile)).enabled, false);
    const qa = path.join(sourceRoot, '.local', 'qa');
    await fs.mkdir(qa, { recursive: true });
    await page.screenshot({ path: path.join(qa, 'dashboard-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(qa, 'dashboard-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await dashboard.close(); }
}));
