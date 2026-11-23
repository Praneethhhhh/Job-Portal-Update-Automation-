import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { acquireLock, readJson, validate } from './core.js';
import { publicCycleStatus, runCycle } from './cycle.js';
import { budgetStatus } from './budget.js';
import { readHistory, summarizeHistory } from './history.js';
import { lazyBrowserAdapter } from './browser.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = path.join(root, '.local');
await fs.mkdir(local, { recursive: true });
const command = process.argv[2] ?? 'status';
let release, context, adapter;
try {
  if (command === 'status') {
    const state = await readJson(path.join(local, 'state.json'), { status: 'never-run' });
    console.log(JSON.stringify({ ...state,
      ...publicCycleStatus(await readJson(path.join(local, 'pending-cycle.json'), null)),
      ...budgetStatus(await readJson(path.join(local, 'budget.json'), null)),
      ...summarizeHistory(await readHistory(local)), scheduler: 'not-checked'
    }, null, 2));
  } else {
    if (!['login', 'inspect', 'dry-run', 'save', 'recover'].includes(command)) throw new Error('Unknown command');
    const config = await readJson(path.join(root, 'config.local.json'));
    if (['login', 'inspect'].includes(command)) {
      if (new URL(config.profileUrl).origin !== 'https://www.naukri.com') throw new Error('Invalid profile origin');
      if (!['chrome', 'msedge'].includes(config.browserChannel ?? 'msedge')) throw new Error('Invalid browser');
      release = await acquireLock(local);
      context = await chromium.launchPersistentContext(path.join(local, 'browser', config.browserChannel ?? 'msedge'), { channel: config.browserChannel ?? 'msedge', headless: false });
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(config.profileUrl, { waitUntil: 'domcontentloaded' });
      console.log('Log in or inspect controls in this dedicated browser. Click Resume in Playwright Inspector when finished.');
      await page.pause();
    } else {
      validate(config, ['save', 'recover'].includes(command));
      adapter = lazyBrowserAdapter(path.join(local, 'browser', config.browserChannel ?? 'msedge'), config);
      if (command === 'dry-run') {
        release = await acquireLock(local);
        console.log(JSON.stringify(await adapter.dryRun()));
      } else {
        const authorize = async () => {
          const latest = await readJson(path.join(root, 'config.local.json'));
          return latest.enabled === true && latest.permissionConfirmed === true;
        };
        let result = await runCycle({ directory: local, adapter, minimumIntervalMinutes: config.minimumIntervalMinutes, recoverOnly: command === 'recover', authorize });
        console.log(JSON.stringify(result));
        await adapter.close();
        if (result.outcome === 'failed' && result.retryable && ['retry-wait', 'retry-ready'].includes(result.budgetState)) {
          const delay = Math.max(0, Date.parse(result.nextEligibleAt) - Date.now());
          console.log(JSON.stringify({ outcome: 'retry-scheduled', at: result.nextEligibleAt }));
          await new Promise(resolve => setTimeout(resolve, delay));
          // Re-read activation so turning Off also cancels a waiting retry.
          const latest = await readJson(path.join(root, 'config.local.json'));
          validate(latest, true);
          result = await runCycle({ directory: local, adapter, minimumIntervalMinutes: latest.minimumIntervalMinutes, recoverOnly: command === 'recover', authorize });
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
