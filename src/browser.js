import { chromium } from 'playwright';
import { WorkflowError } from './errors.js';
import { setTimeout as pauseFor } from 'node:timers/promises';

export function createBrowserAdapter(page, config, { discoverSuccess = false, pause = pauseFor } = {}) {
  const s = config.selectors;
  const postSaveDelayMs = config.postSaveDelayMs ?? 5000;
  if (!Number.isFinite(postSaveDelayMs) || postSaveDelayMs < 5000 || postSaveDelayMs > 120000) throw new WorkflowError('invalid-post-save-delay');
  page.setDefaultTimeout(config.timeoutMs);
  let verifiedName = null;
  let restricted = false;
  page.on('response', response => { if ([403, 429].includes(response.status())) restricted = true; });
  async function challenge() {
    if (restricted) throw new WorkflowError('access-restricted');
    const current = new URL(page.url());
    if (current.protocol !== 'https:' || current.origin !== new URL(config.profileUrl).origin) {
      throw new WorkflowError('unexpected-profile-origin');
    }
    if (/login|registration/i.test(new URL(page.url()).pathname) ||
        await page.locator(s.challenge || 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey]').filter({ visible: true }).count() ||
        await page.getByText(/^(?:verify you are human|complete the captcha|security verification|enter (?:the )?otp)$/i).filter({ visible: true }).count()) throw new WorkflowError('authentication-required');
  }
  async function unique(locator) {
    if (await locator.count() > 1) throw new WorkflowError('ambiguous-editor');
    try { await locator.waitFor({ state: 'visible' }); }
    catch { await challenge(); throw new WorkflowError('editor-unavailable'); }
    if (await locator.count() !== 1) throw new WorkflowError('ambiguous-editor');
    return locator;
  }
  async function guarded(operation) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof WorkflowError) throw error;
      // Navigation and clicks can fail because authentication changed underneath
      // them. Never turn those interruptions into transient automatic retries.
      try { await challenge(); }
      catch (checkError) {
        if (checkError instanceof WorkflowError) throw checkError;
        // A closed/uninspectable page cannot establish that retrying is safe.
        throw new WorkflowError('security-state-unavailable');
      }
      throw new WorkflowError('browser-operation-failed', true);
    }
  }
  async function editor(reopen) {
    if (reopen) {
      const response = await page.goto(config.profileUrl, { waitUntil: 'domcontentloaded' });
      if ([403, 429].includes(response?.status())) throw new WorkflowError('access-restricted');
      if (response?.status() >= 500) throw new WorkflowError('site-unavailable', true);
    }
    await challenge();
    let modal = page.locator(s.editor);
    if (await modal.filter({ visible: true }).count()) {
      if (await title(modal).count() !== 1) {
        await (await unique(modal.locator(s.close))).click();
        await modal.waitFor({ state: 'hidden' });
      }
    }
    if (!(await modal.filter({ visible: true }).count())) await (await unique(page.locator(s.edit))).click();
    modal = await unique(page.locator(s.editor));
    await unique(title(modal));
    const name = await unique(modal.locator(s.name));
    if (!(await name.evaluate(e => e.tagName === 'INPUT' && ['text', ''].includes(e.getAttribute('type') ?? '')))) throw new WorkflowError('unsupported-name-field');
    await challenge();
    return { modal, name };
  }
  function title(modal) {
    return s.heading ? modal.locator(s.heading).filter({ hasText: /^\s*Basic details\s*$/ }) : modal.getByRole('heading', { name: 'Basic details', exact: true });
  }
  // First supervised setup can discover the actual generic success message from
  // rendered DOM. Only allowlisted messages qualify; profile text never leaves
  // the page. A message already visible before the click is not fresh evidence.
  const successPhrases = ['profile updated successfully', 'profile successfully updated', 'basic details updated successfully',
    'details updated successfully', 'your profile has been updated successfully', 'changes saved successfully', 'profile saved successfully'];
  const visibleSuccess = ({ phrases, before = [] }) => {
    const nodes = [...document.querySelectorAll('body *')];
    return nodes.filter(e => e.children.length === 0 && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
      .map(e => e.textContent.trim()).filter(text => phrases.includes(text.toLowerCase().replace(/[.!]+$/, '').trim()) && !before.includes(text));
  };
  async function otherFields(modal) {
    return modal.locator('input, textarea, select, [contenteditable="true"]').evaluateAll((elements, selector) =>
      elements.filter(e => !e.matches(selector)).map(e => ({
        tag: e.tagName, id: e.id, name: e.getAttribute('name'), type: e.getAttribute('type'),
        value: e.isContentEditable ? e.textContent : e.value, checked: e.checked,
        selected: e.tagName === 'SELECT' ? Array.from(e.selectedOptions).map(o => o.value) : undefined
      })), s.name);
  }
  return {
    async readName() {
      // Reuse the independent server read just performed by saveName exactly
      // once. The coordinator need not reload the same profile a second time.
      if (verifiedName !== null) { const value = verifiedName; verifiedName = null; return value; }
      return guarded(async () => (await editor(true)).name.inputValue());
    },
    async dryRun() {
      return guarded(async () => {
        verifiedName = null;
        const { modal, name } = await editor(true);
        if (!(await name.inputValue()).trim()) throw new WorkflowError('empty-name');
        await unique(modal.locator(s.save));
        return { outcome: 'dry-run-passed' };
      });
    },
    async saveName(expected, next) {
      return guarded(async () => {
        verifiedName = null;
        const { modal, name } = await editor(false);
        if (await name.inputValue() !== expected) throw new WorkflowError('name-conflict');
        const before = JSON.stringify(await otherFields(modal));
        await challenge();
        await name.fill(next);
        if (await name.inputValue() !== next || !(await name.evaluate(e => e.checkValidity()))) throw new WorkflowError('name-validation-rejected');
        if (JSON.stringify(await otherFields(modal)) !== before) throw new WorkflowError('other-fields-changed');
        await challenge();
        const save = await unique(modal.locator(s.save));
        if (!(await save.isEnabled())) throw new WorkflowError('save-disabled');
        if (config.confirmationMode === 'persisted-editor') {
          // Naukri may omit the second toast. Closing alone is never success:
          // navigate afresh and verify the server-persisted Name before returning.
          await unique(title(modal));
          if (await name.inputValue() !== next || JSON.stringify(await otherFields(modal)) !== before) throw new WorkflowError('editor-changed-before-save');
          await challenge();
          await save.click();
          await pause(postSaveDelayMs);
          await modal.waitFor({ state: 'hidden' });
          await challenge();
          const persisted = await editor(true);
          if (await persisted.name.inputValue() !== next) throw new WorkflowError('save-unconfirmed', true);
          verifiedName = next;
          return;
        }
        const beforeSuccess = discoverSuccess && !s.success ? await page.evaluate(visibleSuccess, { phrases: successPhrases }) : [];
        if (s.success) await page.locator(s.success).waitFor({ state: 'hidden' });
        await challenge();
        await unique(title(modal));
        if (await name.inputValue() !== next || JSON.stringify(await otherFields(modal)) !== before) throw new WorkflowError('editor-changed-before-save');
        const submittedAt = Date.now();
        await challenge();
        await save.click();
        try {
          if (s.success) await page.locator(s.success).waitFor({ state: 'visible' });
          else if (discoverSuccess) {
            const signal = await page.waitForFunction(({ phrases, before }) => {
              for (const e of document.querySelectorAll('body *')) {
                if (e.children.length || !e.getClientRects().length || getComputedStyle(e).visibility === 'hidden') continue;
                const text = e.textContent.trim();
                if (phrases.includes(text.toLowerCase().replace(/[.!]+$/, '').trim()) && !before.includes(text)) return text;
              }
              return false;
            }, { phrases: successPhrases, before: beforeSuccess });
            const message = await signal.jsonValue();
            s.success = `text=${JSON.stringify(message)}`;
            await signal.dispose();
          } else throw new WorkflowError('success-selector-required');
        }
        catch {
          await challenge();
          if (await page.locator(s.validationError || 'input[aria-invalid="true"], input:invalid').filter({ visible: true }).count()) throw new WorkflowError('name-validation-rejected');
          throw new WorkflowError('save-unconfirmed', true);
        } finally {
          await pause(Math.max(0, postSaveDelayMs - (Date.now() - submittedAt)));
        }
        await challenge();
      });
    }
  };
}

export async function minimizeBrowserWindow(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  } finally {
    await session.detach();
  }
}

export function lazyBrowserAdapter(directory, config, options) {
  let context, adapter;
  async function get() {
    if (!context) {
      try {
        context = await chromium.launchPersistentContext(directory, { channel: config.browserChannel ?? 'msedge', headless: config.headless, viewport: { width: 1280, height: 900 } });
      } catch { throw new WorkflowError('browser-launch-failed', true); }
      const page = context.pages()[0] ?? await context.newPage();
      if (options?.minimize && config.headless !== true) {
        try { await minimizeBrowserWindow(page); }
        catch {
          try {
            await context.close();
            context = null;
          } catch {
            // Leave the context available for the caller's cleanup.
          }
          throw new WorkflowError('browser-minimize-failed');
        }
      }
      adapter = createBrowserAdapter(page, config, options);
    }
    return adapter;
  }
  return {
    readName: async () => (await get()).readName(),
    saveName: async (...args) => (await get()).saveName(...args),
    dryRun: async () => (await get()).dryRun(),
    close: async () => { await context?.close(); context = null; adapter = null; }
  };
}
