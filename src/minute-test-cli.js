import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lazyBrowserAdapter } from './browser.js';
import { runMinuteTest } from './minute-test.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.local');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
try {
  console.log('Bounded live test: two visible cycles, 60 seconds between completed cycles, and at least five seconds after every Save. Stops on failure; normal workflow stays Off.');
  const result = await runMinuteTest({ root, directory, stopped: () => stopping,
    createAdapter: config => lazyBrowserAdapter(path.join(directory, 'browser', config.browserChannel ?? 'msedge'), config),
    onProgress: progress => console.log(JSON.stringify(progress)) });
  console.log(JSON.stringify(result));
  if (result.outcome !== 'completed') process.exitCode = 1;
} catch { console.error('Minute test stopped. Inspect status and any pending restoration before proceeding. No automatic retry.'); process.exitCode = 1; }
