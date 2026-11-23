import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pauseFor } from 'node:timers/promises';
import { acquireControlLock, acquireLock, readJson, writeJson, validate } from './core.js';
import { configurationId } from './verification.js';
import { runCycle } from './cycle.js';
import { validateTestSession } from './test-session.js';

export async function runMinuteTest({ root, directory, createAdapter, pause = pauseFor, now = Date.now, stopped = () => false, onProgress = () => {} }) {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'minute-test.json');
  const configFile = path.join(root, 'config.local.json');
  const config = await readJson(configFile);
  validate({ ...config, enabled: true }, true);
  if (config.enabled !== false) throw new Error('Keep the unattended workflow Off during a bounded test');
  let session;
  const release = await acquireLock(directory);
  try {
    if (await readJson(path.join(directory, 'pending-cycle.json'), null)) throw new Error('Reconcile pending restoration first');
    const prior = await readJson(file, null);
    if (prior) validateTestSession(prior);
    if (prior?.status === 'running' && now() < Date.parse(prior.expiresAt)) throw new Error('Minute test already active');
    session = { version: 1, id: randomUUID(), status: 'running', startedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 300000).toISOString(), cyclesStarted: 0, cyclesCompleted: 0, lastAttemptAt: null };
    await writeJson(file, session);
  } finally { await release(); }
  const update = async change => {
    const unlock = await acquireLock(directory);
    try {
      session = validateTestSession(await readJson(file));
      await writeJson(file, { ...session, ...change });
    } finally { await unlock(); }
  };
  try {
    for (let index = 0; index < 2; index++) {
      if (stopped() || now() >= Date.parse(session.expiresAt)) { await update({ status: 'stopped' }); return { outcome: 'stopped' }; }
      const result = await runCycle({ directory, adapter: createAdapter({ ...config, headless: false }), minimumIntervalMinutes: 1,
        minuteTestSessionId: session.id, now: now(), closeAdapter: true, lockReservation: () => acquireControlLock(directory),
        authorize: async () => {
          const current = await readJson(configFile);
          return !stopped() && current.enabled === false && current.permissionConfirmed === true && configurationId(current) === configurationId(config);
        }
      });
      onProgress({ cycle: index + 1, ...result });
      if (result.outcome !== 'restored') { await update({ status: 'failed' }); return { outcome: 'failed', reason: result.reason ?? 'test-not-eligible' }; }
      await update({ cyclesCompleted: index + 1 });
      if (index === 0) {
        onProgress({ outcome: 'waiting', nextCycleAt: new Date(now() + 60000).toISOString() });
        await pause(60000);
      }
    }
    await update({ status: 'completed' });
    return { outcome: 'completed', cyclesCompleted: 2, normalIntervalMinutes: config.minimumIntervalMinutes };
  } catch (error) { await update({ status: 'failed' }); throw error; }
}
