import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './core.js';

const config = await readJson(fileURLToPath(new URL('../config.local.json', import.meta.url)), {});
if (config.enabled === true) {
  await fs.mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeJson(fileURLToPath(new URL('../.local/windows-session.json', import.meta.url)), { at: new Date().toISOString() });
}
