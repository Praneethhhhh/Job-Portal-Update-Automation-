import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

export function validate(config, saving = false, { readOnly = false, discoverSuccess = false } = {}) {
  const url = new URL(config.profileUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'www.naukri.com') throw new Error('Only https://www.naukri.com profiles are supported');
  if (!Number.isFinite(config.minimumIntervalMinutes) || config.minimumIntervalMinutes < 60) throw new Error('Minimum interval must be at least 60 minutes');
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120000) throw new Error('timeoutMs must be between 1000 and 120000');
  if (config.postSaveDelayMs !== undefined && (!Number.isFinite(config.postSaveDelayMs) || config.postSaveDelayMs < 5000 || config.postSaveDelayMs > 120000)) throw new Error('postSaveDelayMs must be between 5000 and 120000');
  if (!['chrome', 'msedge'].includes(config.browserChannel ?? 'msedge')) throw new Error('Browser must be chrome or msedge');
  if (config.confirmationMode !== undefined && !['toast-and-editor', 'persisted-editor'].includes(config.confirmationMode)) throw new Error('Invalid confirmation mode');
  for (const key of ['edit', 'editor', 'name', 'close', 'save', ...(!readOnly && !discoverSuccess && config.confirmationMode !== 'persisted-editor' ? ['success'] : [])]) {
    if (typeof config.selectors?.[key] !== 'string' || !config.selectors[key].trim()) throw new Error(`Configure selectors.${key} from the actual page first`);
  }
  if (saving && (config.enabled !== true || config.permissionConfirmed !== true)) throw new Error('Saving requires enabled and permissionConfirmed in config.local.json');
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

export async function acquireControlLock(directory) {
  const control = path.join(directory, 'control');
  await fs.mkdir(control, { recursive: true });
  return acquireLock(control);
}

export async function acquireLock(directory) {
  const file = path.join(directory, 'run.lock');
  const publish = async () => {
    const temporary = path.join(directory, `run.lock.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600, flush: true });
      // Publish complete ownership atomically and refuse to replace a lock.
      await fs.link(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  };
  try { await publish(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-lock removal with an OS-owned guard that dies with the
    // process. Ordinary acquisitions still use exclusive file creation.
    const guard = net.createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        guard.once('error', reject);
        guard.listen({ host: '127.0.0.1', port: 49381, exclusive: true }, resolve);
      });
    } catch (guardError) {
      if (guardError.code === 'EADDRINUSE') throw error;
      throw guardError;
    }
    try {
      let owner;
      try { owner = await readJson(file); }
      catch (readError) { if (readError.code !== 'ENOENT') throw error; }
      if (owner !== undefined) {
        if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) throw error;
        try { process.kill(owner.pid, 0); }
        catch (probe) {
          if (probe.code !== 'ESRCH') throw error;
          await fs.unlink(file);
          owner = null;
        }
        if (owner !== null) throw error;
      }
      await publish();
    } finally { await new Promise(resolve => guard.close(resolve)); }
  }
  return () => fs.unlink(file);
}
