import fs from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { acquireLock, readJson, validate } from './core.js';
import { runCycle } from './cycle.js';
import { configurationId } from './verification.js';
import { automationReadiness } from './operation.js';

export async function runScheduledTick({ root, directory, createAdapter, now = Date.now(), canRun = async () => true }) {
  const configFile = path.join(root, 'config.local.json');
  const config = await readJson(configFile, {});
  if (config.enabled !== true) return { outcome: 'skipped', reason: 'workflow-off' };
  const ready = await automationReadiness(directory, config);
  if (!ready.ready) return { outcome: 'skipped', reason: 'validation-required' };
  validate(config, true);
  // Running a coordinator tick even during cooldown also reconciles interrupted
  // reservations. No browser launches until an attempt has been reserved.
  const adapter = createAdapter(config);
  try {
    const session = await readJson(path.join(directory, 'windows-session.json'), null);
    const sessionStartedAt = Date.parse(session?.at);
    const control = path.join(directory, 'control');
    await fs.mkdir(control, { recursive: true });
    return await runCycle({ directory, adapter, now, sessionStartedAt: sessionStartedAt <= now ? sessionStartedAt : undefined, minimumIntervalMinutes: config.minimumIntervalMinutes, closeAdapter: true,
      scheduledIntervalMs: randomInt(35 * 60, 45 * 60 + 1) * 1000,
      lockReservation: () => acquireLock(control),
      authorize: async ({ reservation } = {}) => {
        if (reservation && !(await canRun())) return false;
        const latest = await readJson(configFile);
        return latest.enabled === true && configurationId(latest) === ready.configurationId &&
          (latest.headless === true) === (config.headless === true) &&
          (await automationReadiness(directory, latest)).ready;
      }
    });
  } catch (error) {
    if (error.code === 'EEXIST') return { outcome: 'skipped', reason: 'already-running' };
    throw error;
  } finally { await adapter.close(); }
}

export async function acquireRunnerLock(directory) {
  const runnerDirectory = path.join(directory, 'runner');
  await fs.mkdir(runnerDirectory, { recursive: true });
  return acquireLock(runnerDirectory);
}
