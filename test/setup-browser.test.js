import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createBrowserAdapter } from '../src/browser.js';
import { inspectControls } from '../src/inspection.js';
import { runCycle } from '../src/cycle.js';
import { readHistory } from '../src/history.js';
import { validate } from '../src/core.js';

async function fixture(options, fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-browser-'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const config = { profileUrl: 'https://www.naukri.com/mnjuser/profile', timeoutMs: 1000, minimumIntervalMinutes: 60, enabled: true, permissionConfirmed: true,
    selectors: { edit: '#edit', editor: '#editor', heading: '.hdn-bold', name: '#name', close: '.close', save: '#save', success: '', challenge: '', validationError: '' } };
  const model = { name: 'Private Original', saves: [], pauses: [], requests: 0, ...options };
  await page.route('https://www.naukri.com/**', async route => {
    model.requests++;
    if (route.request().method() === 'POST') {
      const requested = route.request().postDataJSON().name;
      if (!model.ignoreSave) model.name = requested;
      model.saves.push(requested);
      return route.fulfill({ json: { ok: true } });
    }
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><button id="edit">Edit</button>
      <div id="editor" hidden><div class="hdn-bold">${model.wrongTitle ? 'Resume headline' : 'Basic details'}</div><button class="close">Close</button>
      <input id="name" aria-label="Name" type="text" required value="${model.name}"><input id="salary" value="Private salary"><button id="save">Save</button></div>
      <div id="message" ${model.staleSuccess ? '' : 'hidden'}>Profile updated successfully</div>
      <script>
      document.querySelector('#edit').onclick=()=>document.querySelector('#editor').hidden=false;
      document.querySelector('.close').onclick=()=>document.querySelector('#editor').hidden=true;
      document.querySelector('#save').onclick=async()=>{await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.querySelector('#name').value})});${model.noToast ? '' : "document.querySelector('#message').hidden=false;"}document.querySelector('#editor').hidden=true;};
      </script>` });
  });
  try { await fn({ directory, page, config, model, adapter: createBrowserAdapter(page, config, { discoverSuccess: true, ...(!model.realDelay ? { pause: async ms => { model.pauses.push(ms); } } : {}) }) }); }
  finally { await browser.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

test('observed plain-text Basic details title works; first setup discovers fresh success and restores exactly', async () => fixture({}, async ({ directory, config, model, adapter }) => {
  assert.doesNotThrow(() => validate(config, true, { discoverSuccess: true }));
  assert.throws(() => validate(config, true), /success/);
  assert.equal((await runCycle({ directory, adapter })).outcome, 'restored');
  assert.deepEqual(model.saves, ['Private Original.', 'Private Original']);
  assert.equal(config.selectors.success, 'text="Profile updated successfully"');
  assert.equal((await readHistory(directory)).filter(row => row.outcome === 'cycle-completed').length, 1);
  assert.doesNotThrow(() => validate(config, true));
}));

test('read-only inspection reports controls and title without field values, then dry-run makes no edits', async () => fixture({}, async ({ page, config, model, adapter }) => {
  await page.goto(config.profileUrl);
  const report = await inspectControls(page, '#edit');
  assert.ok(report.controls.some(row => row.id === 'name'));
  assert.ok(report.labels.some(row => row.text === 'Basic details'));
  assert.ok(!JSON.stringify(report).includes('Private Original'));
  assert.ok(!JSON.stringify(report).includes('Private salary'));
  assert.doesNotThrow(() => validate(config, false, { readOnly: true }));
  assert.equal((await adapter.dryRun()).outcome, 'dry-run-passed');
  assert.deepEqual(model.saves, []);
}));

test('stale success text cannot certify a supervised save', async () => fixture({ staleSuccess: true }, async ({ directory, config, model, adapter }) => {
  const result = await runCycle({ directory, adapter });
  assert.equal(result.reason, 'save-unconfirmed');
  assert.equal(config.selectors.success, '');
  assert.equal(model.saves.length, 1);
  assert.equal((await readHistory(directory)).filter(row => row.outcome === 'cycle-completed').length, 0);
}));

test('configured title selector still rejects the wrong dialog', async () => fixture({ wrongTitle: true }, async ({ model, adapter }) => {
  await assert.rejects(adapter.dryRun());
  assert.deepEqual(model.saves, []);
}));

test('persisted-editor mode confirms both saves without a toast and restores exactly', async () => fixture({ noToast: true }, async ({ directory, config, model, adapter }) => {
  config.confirmationMode = 'persisted-editor';
  assert.doesNotThrow(() => validate(config, true));
  assert.equal((await runCycle({ directory, adapter })).outcome, 'restored');
  assert.deepEqual(model.saves, ['Private Original.', 'Private Original']);
  assert.equal(model.name, 'Private Original');
  assert.deepEqual(model.pauses, [5000, 5000]);
  assert.equal(model.requests, 5); // Initial read + two saves + two fresh reads.
}));

test('real save pacing waits five seconds after each submission before reopening', async () => fixture({ noToast: true, realDelay: true }, async ({ directory, config, model, adapter }) => {
  config.confirmationMode = 'persisted-editor';
  const before = Date.now();
  assert.equal((await runCycle({ directory, adapter })).outcome, 'restored');
  assert.ok(Date.now() - before >= 10000);
  assert.deepEqual(model.saves, ['Private Original.', 'Private Original']);
}));

test('save pacing cannot be configured below five seconds', async () => fixture({}, async ({ config }) => {
  assert.throws(() => validate({ ...config, postSaveDelayMs: 4999 }, false, { readOnly: true }), /postSaveDelayMs/);
  assert.doesNotThrow(() => validate({ ...config, postSaveDelayMs: 5000 }, false, { readOnly: true }));
}));

test('closing the editor without persisting the requested value is never success', async () => fixture({ noToast: true, ignoreSave: true }, async ({ directory, config, model, adapter }) => {
  config.confirmationMode = 'persisted-editor';
  const result = await runCycle({ directory, adapter });
  assert.equal(result.reason, 'save-unconfirmed');
  assert.equal(model.saves.length, 1);
  assert.equal((await readHistory(directory)).some(row => row.outcome === 'cycle-completed'), false);
}));
