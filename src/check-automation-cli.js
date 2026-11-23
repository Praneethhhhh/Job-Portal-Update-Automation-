import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './core.js';
import { automationReadiness } from './operation.js';

try {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const readiness = await automationReadiness(path.join(root, '.local'), await readJson(path.join(root, 'config.local.json')));
  console.log(readiness.ready ? 'Automation setup verified.' : readiness.reason);
  if (!readiness.ready) process.exitCode = 1;
} catch { console.error('Automation setup is unavailable. Run npm run check-setup.'); process.exitCode = 1; }
