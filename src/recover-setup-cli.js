import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireControlLock, readJson } from './core.js';
import { configurationId } from './verification.js';
import { runCycle } from './cycle.js';
import { budgetStatus } from './budget.js';
import { lazyBrowserAdapter } from './browser.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.local');
const file = path.join(root, 'config.local.json');
let adapter;
try {
  if (process.argv[2] !== '--confirmed') throw new Error('Confirmation required');
  const initial = await readJson(file);
  if (initial.permissionConfirmed !== true) throw new Error('Confirmation required');
  const budget = budgetStatus(await readJson(path.join(directory, 'budget.json'), null));
  if (budget.budgetState === 'retry-wait') {
    const delay = Math.max(0, Date.parse(budget.nextEligibleAt) - Date.now());
    console.log(JSON.stringify({ outcome: 'waiting-for-recovery-budget', at: budget.nextEligibleAt }));
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  const config = await readJson(file);
  adapter = lazyBrowserAdapter(path.join(directory, 'browser', config.browserChannel ?? 'msedge'), { ...config, headless: false }, { discoverSuccess: true });
  const result = await runCycle({ directory, adapter, recoverOnly: true, minimumIntervalMinutes: config.minimumIntervalMinutes, closeAdapter: true,
    lockReservation: () => acquireControlLock(directory),
    authorize: async () => {
      const latest = await readJson(file);
      return latest.enabled === initial.enabled && latest.permissionConfirmed === true && configurationId(latest) === configurationId(config);
    }
  });
  console.log(JSON.stringify(result));
  if (result.outcome !== 'restored') process.exitCode = 1;
} catch { console.error('Setup recovery could not complete. Inspect status; no new cycle was started.'); process.exitCode = 1; }
finally {
  await adapter?.close();
}
