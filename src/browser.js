import { chromium } from 'playwright';
import { WorkflowError } from './errors.js';

export function createBrowserAdapter(page, config) {
  const s = config.selectors;
  page.setDefaultTimeout(config.timeoutMs);
  let restricted = false;
  page.on('response', response => { if ([403, 429].includes(response.status())) restricted = true; });
  async function challenge() {
    if (restricted) throw new WorkflowError('access-restricted');
    if (/login|registration/i.test(new URL(page.url()).pathname) ||
        await page.locator(s.challenge).filter({ visible: true }).count()) throw new WorkflowError('authentication-required');
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
      if (await modal.getByRole('heading', { name: 'Basic details', exact: true }).count() !== 1) {
        await (await unique(modal.locator(s.close))).click();
        await modal.waitFor({ state: 'hidden' });
      }
    }
    if (!(await modal.filter({ visible: true }).count())) await (await unique(page.locator(s.edit))).click();
    modal = await unique(page.locator(s.editor));
    await unique(modal.getByRole('heading', { name: 'Basic details', exact: true }));
    const name = await unique(modal.locator(s.name));
    if (!(await name.evaluate(e => e.tagName === 'INPUT' && ['text', ''].includes(e.getAttribute('type') ?? '')))) throw new WorkflowError('unsupported-name-field');
    await challenge();
    return { modal, name };
  }
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
      return guarded(async () => (await editor(true)).name.inputValue());
    },
    async dryRun() {
      return guarded(async () => {
        const { modal, name } = await editor(true);
        if (!(await name.inputValue()).trim()) throw new WorkflowError('empty-name');
        await unique(modal.locator(s.save));
        return { outcome: 'dry-run-passed' };
      });
    },
    async saveName(expected, next) {
      return guarded(async () => {
        const { modal, name } = await editor(false);
        if (await name.inputValue() !== expected) throw new WorkflowError('name-conflict');
        const before = JSON.stringify(await otherFields(modal));
        await name.fill(next);
        if (await name.inputValue() !== next || !(await name.evaluate(e => e.checkValidity()))) throw new WorkflowError('name-validation-rejected');
        if (JSON.stringify(await otherFields(modal)) !== before) throw new WorkflowError('other-fields-changed');
        await challenge();
        const save = await unique(modal.locator(s.save));
        if (!(await save.isEnabled())) throw new WorkflowError('save-disabled');
        await page.locator(s.success).waitFor({ state: 'hidden' });
        await challenge();
        await unique(modal.getByRole('heading', { name: 'Basic details', exact: true }));
        if (await name.inputValue() !== next || JSON.stringify(await otherFields(modal)) !== before) throw new WorkflowError('editor-changed-before-save');
        await save.click();
        try { await page.locator(s.success).waitFor({ state: 'visible' }); }
        catch {
          await challenge();
          if (await page.locator(s.validationError).filter({ visible: true }).count()) throw new WorkflowError('name-validation-rejected');
          throw new WorkflowError('save-unconfirmed', true);
        }
        await challenge();
      });
    }
  };
}

export function lazyBrowserAdapter(directory, config) {
  let context, adapter;
  async function get() {
    if (!context) {
      try {
        context = await chromium.launchPersistentContext(directory, { channel: config.browserChannel ?? 'msedge', headless: config.headless, viewport: { width: 1280, height: 900 } });
        adapter = createBrowserAdapter(context.pages()[0] ?? await context.newPage(), config);
      } catch { throw new WorkflowError('browser-launch-failed', true); }
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
