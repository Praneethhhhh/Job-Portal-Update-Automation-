import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validate, due, acquireLock, readJson, writeJson } from '../src/core.js';
const config = { profileUrl: 'https://www.naukri.com/mnjuser/profile', minimumIntervalMinutes: 60, timeoutMs: 30000, selectors: { edit: 'a', editor: 'b', save: 'c', success: 'd', challenge: 'e', name: 'input', close: '.close', validationError: '.error' } };
test('refuses saves without activation and permission', () => {
  assert.throws(() => validate(config, true), /permissionConfirmed/);
  assert.doesNotThrow(() => validate({ ...config, enabled: true, permissionConfirmed: true }, true));
});
test('rejects untrusted origins, missing selectors and rapid schedules', () => {
  assert.throws(() => validate({ ...config, profileUrl: 'https://www.naukri.com.evil.example/profile' }));
  assert.throws(() => validate({ ...config, selectors: {} }));
  assert.throws(() => validate({ ...config, minimumIntervalMinutes: 1 }));
});
test('failed attempts also impose an hourly cooldown', () => {
  const now = Date.now();
  assert.equal(due({ lastAttemptAt: new Date(now - 1000).toISOString() }, config, now), false);
  assert.equal(due({ lastAttemptAt: new Date(now - 3600000).toISOString() }, config, now), true);
  assert.equal(due({}, config, now), true);
});
test('exclusive lock prevents overlap and releases; state round trips', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'naukri-test-'));
  try {
    const release = await acquireLock(dir);
    await assert.rejects(acquireLock(dir), { code: 'EEXIST' });
    await release();
    const releaseAgain = await acquireLock(dir);
    await releaseAgain();
    const file = path.join(dir, 'state.json');
    await writeJson(file, { status: 'success' });
    assert.deepEqual(await readJson(file), { status: 'success' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
