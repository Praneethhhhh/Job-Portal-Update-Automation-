import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { acquireControlLock, acquireLock, readJson, validate } from './core.js';
import { configurationId } from './verification.js';
import { publicCycleStatus, runCycle } from './cycle.js';
import { budgetStatus } from './budget.js';
import { readHistory, summarizeHistory } from './history.js';
import { lazyBrowserAdapter } from './browser.js';
import { operationStatus } from './operation.js';
import { inspectControls } from './inspection.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = path.join(root, '.local');
await fs.mkdir(local, { recursive: true });
const command = process.argv[2] ?? 'status';
let release, context, adapter;
try {
  if (command === 'status') {
    const state = await readJson(path.join(local, 'state.json'), { status: 'never-run' });
    const operation = await operationStatus({ root, directory: local });
    console.log(JSON.stringify({ ...state,
      ...publicCycleStatus(await readJson(path.join(local, 'pending-cycle.json'), null)),
      ...budgetStatus(await readJson(path.join(local, 'budget.json'), null)),
      ...summarizeHistory(await readHistory(local)), enabled: operation.enabled, scheduler: operation.scheduler,
      nextEligibleAt: operation.nextEligibleAt, budgetState: operation.budgetState
    }, null, 2));
  } else {
    if (!['login', 'inspect', 'dry-run', 'save', 'recover'].includes(command)) throw new Error('Unknown command');
    const config = await readJson(path.join(root, 'config.local.json'));
    if (['login', 'inspect'].includes(command)) {
      if (new URL(config.profileUrl).origin !== 'https://www.naukri.com') throw new Error('Invalid profile origin');
      if (!['chrome', 'msedge'].includes(config.browserChannel ?? 'msedge')) throw new Error('Invalid browser');
      release = await acquireLock(local);
      context = await chromium.launchPersistentContext(path.join(local, 'browser', config.browserChannel ?? 'msedge'), { channel: config.browserChannel ?? 'msedge', headless: false });
      // Let diagnostic windows close gracefully on Ctrl+C so the shared lock
      // is released by finally instead of being stranded by process exit.
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void context?.close().catch(() => {}); });
      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(config.timeoutMs ?? 30000);
      await page.goto(config.profileUrl, { waitUntil: 'domcontentloaded' });
      if (command === 'inspect' && process.argv.includes('--report')) {
        // Hydrated profile controls may arrive after the initial document.
        await page.locator('button, [class*="edit" i]').first().waitFor({ state: 'visible', timeout: config.timeoutMs });
        const targetIndex = process.argv.indexOf('--open-editor');
        console.log(JSON.stringify(await inspectControls(page, targetIndex < 0 ? undefined : process.argv[targetIndex + 1]), null, 2));
        if (process.argv.includes('--keep-open')) {
          console.log('Read-only inspection complete. This Chrome window will stay open until you close it. No profile fields have been changed.');
          await new Promise(resolve => context.once('close', resolve));
        }
      } else {
        console.log('Log in or inspect controls in this dedicated browser. Click Resume in Playwright Inspector when finished.');
        console.log('Resume closes this browser. It does not discover selectors or enable the workflow.');
        await page.pause();
        console.log(JSON.stringify({ outcome: 'session-saved', next: 'Run npm run check-setup. Page selectors and validation must still be configured before On becomes available.' }));
      }
    } else {
      validate(config, ['save', 'recover'].includes(command), { readOnly: command === 'dry-run' });
      adapter = lazyBrowserAdapter(path.join(local, 'browser', config.browserChannel ?? 'msedge'), config);
      if (command === 'dry-run') {
        release = await acquireLock(local);
        console.log(JSON.stringify(await adapter.dryRun()));
      } else {
        const authorize = async () => {
          const latest = await readJson(path.join(root, 'config.local.json'));
          return latest.enabled === true && latest.permissionConfirmed === true &&
            configurationId(latest) === configurationId(config) && (latest.headless === true) === (config.headless === true);
        };
        const attempt = () => runCycle({ directory: local, adapter, minimumIntervalMinutes: config.minimumIntervalMinutes,
          recoverOnly: command === 'recover', authorize, closeAdapter: true, lockReservation: () => acquireControlLock(local) });
        let result = await attempt();
        console.log(JSON.stringify(result));
        if (result.outcome === 'failed' && result.retryable && ['retry-wait', 'retry-ready'].includes(result.budgetState)) {
          const delay = Math.max(0, Date.parse(result.nextEligibleAt) - Date.now());
          console.log(JSON.stringify({ outcome: 'retry-scheduled', at: result.nextEligibleAt }));
          await new Promise(resolve => setTimeout(resolve, delay));
          // Re-read activation so turning Off also cancels a waiting retry.
          result = await attempt();
          console.log(JSON.stringify(result));
        }
        if (result.outcome === 'failed') process.exitCode = 1;
      }
    }
  }
} catch {
  console.error(JSON.stringify({ outcome: 'failed', reason: 'Command could not complete; check configuration, local state and active lock' }));
  process.exitCode = 1;
} finally {
  try { await adapter?.close(); await context?.close(); } finally { await release?.(); }
}
