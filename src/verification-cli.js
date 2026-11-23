import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, validate } from './core.js';
import { lazyBrowserAdapter } from './browser.js';
import { checkSetup, verifyDryRun, verifyCycle } from './verification.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.local');
const [command, ...flags] = process.argv.slice(2);
let adapter;
try {
  if (!['check-setup', 'verify', 'verify-save'].includes(command) ||
      flags.some(flag => flag !== '--background') || (flags.length && command !== 'verify')) throw new Error('Invalid verification command');
  if (command === 'check-setup') {
    console.log(JSON.stringify(await checkSetup({ root, directory }), null, 2));
  } else {
    const readConfig = () => readJson(path.join(root, 'config.local.json'));
    const config = await readConfig();
    validate(config, command === 'verify-save', { readOnly: command === 'verify' });
    await fs.mkdir(directory, { recursive: true });
    const background = command === 'verify-save' ? config.headless === true : flags.includes('--background');
    adapter = lazyBrowserAdapter(path.join(directory, 'browser', config.browserChannel ?? 'msedge'), { ...config, headless: background });
    if (command === 'verify-save') console.log('Supervised live check: real Name edits, followed by exact restoration. One attempt; no automatic retry.');
    const options = { directory, config, adapter, background, readConfig };
    const result = await (command === 'verify-save' ? verifyCycle(options) : verifyDryRun(options));
    console.log(JSON.stringify(result, null, 2));
    if (result.outcome !== 'passed') process.exitCode = 1;
  }
} catch (error) {
  const reason = error.code === 'EEXIST'
    ? 'Another scheduler or verification command held the run lock. Wait for it to finish, then retry.'
    : error.code === 'EPERM' || error.code === 'EACCES'
      ? 'Windows denied access to a local file or lock. Check project folder access.'
      : 'Validation stopped unexpectedly. Check local setup and recovery status.';
  console.error(JSON.stringify({ outcome: 'failed', reason }));
  process.exitCode = 1;
} finally { await adapter?.close(); }
