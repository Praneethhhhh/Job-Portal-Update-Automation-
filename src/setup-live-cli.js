import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, validate, acquireLock, acquireControlLock } from './core.js';
import { runCycle } from './cycle.js';
import { lazyBrowserAdapter } from './browser.js';
import { configurationId, readVerification, verifyDryRun } from './verification.js';
import { readHistory } from './history.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.local');
const configFile = path.join(root, 'config.local.json');
let adapter;
try {
  if (process.argv[2] !== '--confirmed') throw new Error('Explicit supervised confirmation required');
  const config = await readJson(configFile);
  if (config.permissionConfirmed !== true) throw new Error('Permission confirmation required');
  if (await readJson(path.join(directory, 'pending-cycle.json'), null)) throw new Error('Reconcile existing pending recovery first');
  const live = { ...config, enabled: true, selectors: { ...config.selectors } };
  validate(live, true, { discoverSuccess: true });
  adapter = lazyBrowserAdapter(path.join(directory, 'browser', config.browserChannel ?? 'msedge'), { ...live, headless: false }, { discoverSuccess: true });
  console.log('Starting one authorized supervised cycle in visible Chrome. No automatic retry. The browser closes after the cycle; login stays saved.');
  const startedAt = new Date().toISOString();
  const result = await runCycle({ directory, adapter, minimumIntervalMinutes: config.minimumIntervalMinutes, closeAdapter: true,
    lockReservation: () => acquireControlLock(directory),
    authorize: async () => {
      const current = await readJson(configFile);
      return current.enabled === config.enabled && current.permissionConfirmed === true && configurationId(current) === configurationId(config);
    }
  });
  console.log(JSON.stringify(result));
  const history = await readHistory(directory);
  const completed = history.find(row => row.outcome === 'cycle-completed' && row.cycleId === result.cycleId && row.action === 'cycle' && row.at >= startedAt);
  if (result.outcome !== 'restored' || !completed || !live.selectors.success) throw new Error('Supervised cycle not verified; inspect recovery status');
  // Only persist a success selector actually observed after this live save.
  let verified;
  const unlockControl = await acquireControlLock(directory);
  try {
    const current = await readJson(configFile);
    if (configurationId(current) !== configurationId(config)) throw new Error('Configuration changed during supervised test');
    verified = { ...current, selectors: { ...current.selectors, success: live.selectors.success } };
    await writeJson(configFile, verified);
  } finally { await unlockControl(); }
  const readConfig = () => readJson(configFile);
  adapter = lazyBrowserAdapter(path.join(directory, 'browser', verified.browserChannel ?? 'msedge'), { ...verified, headless: false });
  const check = await verifyDryRun({ directory, config: verified, adapter, readConfig });
  console.log(JSON.stringify(check));
  if (check.outcome !== 'passed') throw new Error('Read-only verification failed');
  const release = await acquireLock(directory);
  try {
    if (configurationId(await readConfig()) !== configurationId(verified)) throw new Error('Configuration changed');
    const report = await readVerification(directory);
    report.checks.supervisedCycle = { configurationId: configurationId(verified), status: 'passed', at: completed.at, headless: false };
    await writeJson(path.join(directory, 'validation.json'), report);
  } finally { await release(); }
  console.log(JSON.stringify({ outcome: 'setup-verified' }));
} catch {
  console.error('Supervised setup could not finish. Inspect npm run status for recovery; no automatic retry was started.');
  process.exitCode = 1;
} finally {
  await adapter?.close();
}
