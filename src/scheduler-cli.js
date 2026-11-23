import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lazyBrowserAdapter } from './browser.js';
import { runScheduledTick, acquireRunnerLock } from './scheduler.js';
import { windowsTaskStatus } from './operation.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.local');
let stopping = false, timer, wake;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; clearTimeout(timer); wake?.(); });
let release;
try {
  if (process.argv.slice(2).some(flag => flag !== '--managed')) throw new Error();
  release = await acquireRunnerLock(directory);
  const managed = process.argv.includes('--managed');
  let available = true;
  let nextTaskCheck = 0;
  while (!stopping) {
    if (managed && Date.now() >= nextTaskCheck) {
      const scheduler = await windowsTaskStatus(root);
      nextTaskCheck = Date.now() + 60000;
      // Disabling/removing a task lets an in-progress reserved cycle finish,
      // then the worker exits rather than performing another attempt.
      if (['paused', 'not-installed'].includes(scheduler.state)) break;
      available = scheduler.state === 'enabled';
    }
    try {
      const result = available ? await runScheduledTick({ root, directory,
        canRun: async () => !stopping && (!managed || (await windowsTaskStatus(root)).state === 'enabled'),
        createAdapter: config => lazyBrowserAdapter(path.join(directory, 'browser', config.browserChannel ?? 'msedge'), config) }) : { outcome: 'skipped' };
      if (result.outcome !== 'skipped') console.log(JSON.stringify(result));
    } catch { console.error(JSON.stringify({ outcome: 'failed', reason: 'Scheduler tick could not complete; inspect local setup.' })); }
    // Short wall-clock polling naturally resumes with one eligibility check;
    // no list of missed hours or in-memory attempt count is replayed.
    if (!stopping) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 15000); });
  }
} catch (error) {
  if (error.code !== 'EEXIST') { console.error('Scheduler could not start; check setup and the runner lock.'); process.exitCode = 1; }
} finally { await release?.(); }
