import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createBrowserAdapter } from '../src/browser.js';
import { runCycle } from '../src/cycle.js';
import { readHistory, summarizeHistory } from '../src/history.js';

const config = {
  profileUrl: 'https://profile.test/profile?action=modalOpen', timeoutMs: 1500,
  selectors: { edit: '#basic-edit', editor: '#editor', name: '#name', close: '.close', save: '.save', success: '#success', challenge: '#challenge', validationError: '#validation' }
};

async function fixture(options, fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-cycle-'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const model = { name: 'Original Name', saves: [], requests: 0, ...options };
  await page.route('https://profile.test/**', async route => {
    const request = route.request();
    model.requests++;
    if (request.method() === 'POST') {
      if (model.rateLimited) return route.fulfill({ status: 429, json: { ok: false } });
      const body = request.postDataJSON();
      model.saves.push(body);
      model.name = body.name;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      <button id="basic-edit">Edit Basic details</button>
      <button id="headline-edit">Edit headline</button>
      <div id="editor" role="dialog" hidden>
        <h2></h2><button class="close">Close</button>
        <input id="name" type="text" required aria-label="Name">
        <input id="salary" type="text" value="0" aria-label="Salary">
        <textarea id="headline" hidden>Keep this headline</textarea>
        <button class="save">Save</button>
      </div>
      <div id="success" hidden>Profile successfully updated</div>
      <div id="challenge" ${model.challenge ? '' : 'hidden'}>CAPTCHA</div>
      <div id="validation" hidden>Invalid name</div>
      <script>
        const baseline = ${JSON.stringify(model.name)};
        const editor = document.querySelector('#editor');
        const nameInput = document.querySelector('#name');
        const salary = document.querySelector('#salary');
        const save = document.querySelector('.save');
        function open(kind) {
          editor.hidden = false;
          editor.querySelector('h2').textContent = kind;
          nameInput.value = baseline;
          nameInput.hidden = kind !== 'Basic details';
          document.querySelector('#headline').hidden = kind !== 'Resume headline';
          save.disabled = true;
        }
        document.querySelector('#basic-edit').onclick = () => open(${JSON.stringify(model.wrongEdit ? 'Resume headline' : 'Basic details')});
        document.querySelector('#headline-edit').onclick = () => open('Resume headline');
        document.querySelector('.close').onclick = () => editor.hidden = true;
        nameInput.oninput = () => {
          save.disabled = nameInput.value === baseline;
          ${model.mutateOther ? "salary.value = '999';" : ''}
        };
        save.onclick = async () => {
          ${model.reject ? "document.querySelector('#validation').hidden = false; return;" : ''}
          await fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameInput.value, salary: salary.value, editor: editor.querySelector('h2').textContent }) });
          editor.hidden = true;
          ${model.noConfirmation ? '' : "document.querySelector('#success').hidden = false;"}
        };
        ${model.initialHeadline ? "open('Resume headline');" : ''}
      </script></body></html>` });
  });
  try { await fn({ directory, page, model, adapter: createBrowserAdapter(page, config, { pause: async () => {} }) }); }
  finally { await browser.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

test('real browser closes wrong same-URL dialog and completes only Basic details saves', async () => fixture({ initialHeadline: true }, async ({ directory, adapter, model }) => {
  assert.equal((await adapter.dryRun()).outcome, 'dry-run-passed');
  assert.equal(model.saves.length, 0);
  assert.equal((await runCycle({ directory, adapter })).outcome, 'restored');
  assert.deepEqual(model.saves, [
    { name: 'Original Name.', salary: '0', editor: 'Basic details' },
    { name: 'Original Name', salary: '0', editor: 'Basic details' }
  ]);
  assert.equal(model.name, 'Original Name');
  assert.equal(summarizeHistory(await readHistory(directory)).completedTotal, 1);
}));

test('redirect to another origin stops before reading or saving the profile', async () => fixture({}, async ({ directory, adapter, model, page }) => {
  await page.route(config.profileUrl, route => route.fulfill({ status: 302, headers: { location: 'https://other.test/profile' } }));
  await page.route('https://other.test/**', route => route.fulfill({ body: 'Other page' }));
  const result = await runCycle({ directory, adapter });
  assert.equal(result.reason, 'unexpected-profile-origin');
  assert.equal(result.retryable, false);
  assert.deepEqual(model.saves, []);
}));

test('wrong edit target cannot submit Resume headline', async () => fixture({ wrongEdit: true }, async ({ directory, adapter, model }) => {
  const result = await runCycle({ directory, adapter });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.retryable, false);
  assert.equal(model.saves.length, 0);
}));

test('other field changing during Name edit blocks submission', async () => fixture({ mutateOther: true }, async ({ directory, adapter, model }) => {
  const result = await runCycle({ directory, adapter });
  assert.equal(result.reason, 'other-fields-changed');
  assert.equal(model.saves.length, 0);
}));

test('challenge stops with no submission or automatic retry', async () => fixture({ challenge: true }, async ({ directory, adapter, model }) => {
  const result = await runCycle({ directory, adapter });
  assert.equal(result.reason, 'authentication-required');
  assert.equal(result.retryable, false);
  assert.equal(model.saves.length, 0);
}));

test('lost save confirmation reconciles temporary Name on single retry and restores', async () => fixture({ noConfirmation: true }, async ({ directory, adapter, model }) => {
  const now = Date.now();
  const first = await runCycle({ directory, adapter, now });
  assert.equal(first.reason, 'save-unconfirmed');
  assert.equal(model.name, 'Original Name.');
  model.noConfirmation = false;
  const second = await runCycle({ directory, adapter, now: Date.parse(first.nextEligibleAt) });
  assert.equal(second.outcome, 'restored');
  assert.equal(model.name, 'Original Name');
  assert.equal(model.saves.length, 2);
  // No verified first confirmation: do not fabricate a completed update.
  assert.equal(summarizeHistory(await readHistory(directory)).completedTotal, 0);
}));

test('validation error stops rather than repeatedly changing the name', async () => fixture({ reject: true }, async ({ directory, adapter, model }) => {
  const result = await runCycle({ directory, adapter });
  assert.equal(result.reason, 'name-validation-rejected');
  assert.equal(result.retryable, false);
  assert.equal(model.saves.length, 0);
}));

test('rate limiting during Save stops retries', async () => fixture({ rateLimited: true }, async ({ directory, adapter, model }) => {
  const result = await runCycle({ directory, adapter });
  assert.equal(result.reason, 'access-restricted');
  assert.equal(result.retryable, false);
  assert.equal(model.name, 'Original Name');
}));

for (const interruption of ['login', 'captcha', 'restricted', 'uninspectable']) {
  test(`generic click failure interrupted by ${interruption} is not retryable`, async () => fixture({}, async ({ directory, adapter, model, page }) => {
    // Let normal browser navigation/editor checks complete, then interrupt the
    // actual Edit click. The generic exception must go through guarded().
    const originalLocator = page.locator.bind(page);
    page.locator = selector => {
      const locator = originalLocator(selector);
      if (selector === '#basic-edit') locator.click = async () => {
        if (interruption === 'login') await page.goto('https://profile.test/login');
        if (interruption === 'captcha') await page.evaluate(() => document.querySelector('#challenge').hidden = false);
        if (interruption === 'restricted') {
          await page.route('https://profile.test/denied', route => route.fulfill({ status: 403, body: 'Denied' }));
          await page.evaluate(() => fetch('/denied'));
        }
        if (interruption === 'uninspectable') await page.close();
        throw new Error('Click interrupted');
      };
      return locator;
    };
    const first = await runCycle({ directory, adapter });
    assert.equal(first.retryable, false);
    assert.equal(first.reason, interruption === 'restricted' ? 'access-restricted' : interruption === 'uninspectable' ? 'security-state-unavailable' : 'authentication-required');
    const requests = model.requests;
    const second = await runCycle({ directory, adapter, now: Date.now() + 61000 });
    assert.equal(second.reason, 'manual-attention');
    assert.equal(model.requests, requests);
    assert.equal(model.saves.length, 0);
  }));
}

test('login-interrupted navigation is not retryable', async () => fixture({}, async ({ directory, adapter, page }) => {
  const goto = page.goto.bind(page);
  page.goto = async () => {
    await goto('https://profile.test/login');
    throw new Error('Navigation interrupted');
  };
  const result = await runCycle({ directory, adapter });
  assert.equal(result.reason, 'authentication-required');
  assert.equal(result.retryable, false);
}));

test('generic click failure without a challenge remains eligible for one retry', async () => fixture({}, async ({ directory, adapter, page }) => {
  const originalLocator = page.locator.bind(page);
  page.locator = selector => {
    const locator = originalLocator(selector);
    if (selector === '#basic-edit') locator.click = async () => { throw new Error('Transient click failure'); };
    return locator;
  };
  const result = await runCycle({ directory, adapter });
  assert.equal(result.reason, 'browser-operation-failed');
  assert.equal(result.retryable, true);
  assert.equal(result.budgetState, 'retry-wait');
}));
