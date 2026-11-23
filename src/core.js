import fs from 'node:fs/promises';
import path from 'node:path';

export function validate(config, saving = false) {
  const url = new URL(config.profileUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'www.naukri.com') throw new Error('Only https://www.naukri.com profiles are supported');
  if (!Number.isFinite(config.minimumIntervalMinutes) || config.minimumIntervalMinutes < 60) throw new Error('Minimum interval must be at least 60 minutes');
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120000) throw new Error('timeoutMs must be between 1000 and 120000');
  if (!['chrome', 'msedge'].includes(config.browserChannel ?? 'msedge')) throw new Error('Browser must be chrome or msedge');
  for (const key of ['edit', 'editor', 'name', 'close', 'save', 'success', 'challenge', 'validationError']) {
    if (typeof config.selectors?.[key] !== 'string' || !config.selectors[key].trim()) throw new Error(`Configure selectors.${key} from the actual page first`);
  }
  if (saving && (!config.enabled || !config.permissionConfirmed)) throw new Error('Saving requires enabled and permissionConfirmed in config.local.json');
}

export function due(state, config, now = Date.now()) {
  return !state.lastAttemptAt || now - Date.parse(state.lastAttemptAt) >= config.minimumIntervalMinutes * 60000;
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, 'w', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } finally {
    await handle?.close();
    await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function acquireLock(directory) {
  const file = path.join(directory, 'run.lock');
  const handle = await fs.open(file, 'wx');
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => { await handle.close(); await fs.unlink(file); };
}
