import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, validate } from './core.js';
import { configurationId, readVerification, verificationStatus } from './verification.js';
import { publicCycleStatus } from './cycle.js';
import { budgetStatus } from './budget.js';
import { readHistory, summarizeHistory } from './history.js';
import { validateTestSession } from './test-session.js';

const execute = promisify(execFile);
export async function windowsTaskStatus(root) {
  if (process.platform !== 'win32') return { state: 'unknown' };
  try {
    const query = `
      $ErrorActionPreference = 'Stop'
      $service = New-Object -ComObject 'Schedule.Service'
      $service.Connect()
      $task = $service.GetFolder('\\').GetTasks(0) | Where-Object Name -eq 'NaukriProfileScheduler' | Select-Object -First 1
      if (!$task) { @{ state = 'not-installed' } | ConvertTo-Json -Compress }
      else {
        $state = if ($task.Enabled) { 'enabled' } else { 'paused' }
        @{ state = $state; running = ($task.State -eq 4); workspace = $task.Definition.Actions.Item(1).WorkingDirectory } | ConvertTo-Json -Compress
      }
    `;
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query],
      { windowsHide: true, timeout: 8000, maxBuffer: 8192 });
    const result = JSON.parse(stdout.trim());
    if (!['enabled', 'paused', 'not-installed', 'unknown'].includes(result.state)) throw new Error();
    if (result.workspace && path.resolve(result.workspace).toLowerCase() !== path.resolve(root).toLowerCase()) return { state: 'unknown' };
    return { state: result.state, running: result.running === true };
  } catch { return { state: 'unknown' }; }
}

export async function automationReadiness(directory, config) {
  try { validate(config); } catch { return { ready: false, reason: 'Complete local configuration first.' }; }
  if (config.permissionConfirmed !== true) return { ready: false, reason: 'Confirm site permission before enabling automation.' };
  if (!verificationStatus(await readVerification(directory), config).liveChecksPassed) {
    return { ready: false, reason: 'Complete supervised validation in the configured browser mode.' };
  }
  return { ready: true, configurationId: configurationId(config) };
}

const outcomes = { 'attempt-started': 'Attempt started', 'cycle-completed': 'Update completed', 'cycle-failed': 'Update failed', 'recovery-failed': 'Recovery failed', 'recovery-restored': 'Original name restored' };
const reasons = {
  'browser-minimize-failed': 'Chrome could not be minimized. The attempt stopped before opening the profile.',
  'other-fields-changed': 'Another editor field changed before Save. No save was sent.',
  'editor-changed-before-save': 'The editor changed before Save. No save was sent.',
  'unexpected-profile-origin': 'Browser left the configured profile site; update stopped',
  'authentication-required': 'Manual login or security check required', 'access-restricted': 'Access restricted; manual attention required',
  'name-conflict': 'Profile changed; manual reconciliation required', 'name-validation-rejected': 'Site rejected the temporary value',
  'save-unconfirmed': 'Save confirmation missing; reconcile before another write', 'process-interrupted': 'Previous process was interrupted',
  'browser-operation-failed': 'Browser operation failed', 'browser-launch-failed': 'Browser could not start',
  'site-unavailable': 'Site temporarily unavailable', 'security-state-unavailable': 'Security state could not be checked'
};

export function activityDisplay(row) {
  return {
    at: new Date(row.at).toISOString(), action: row.mode === 'minute-test' ? 'Test cycle' : row.action === 'recovery' ? 'Recovery' : 'New cycle',
    outcome: outcomes[row.outcome], explanation: row.reason ? reasons[row.reason] ?? 'Stopped; inspect local setup and recovery status' : outcomes[row.outcome]
  };
}

export async function operationStatus({ root, directory, now = Date.now(), taskStatus = windowsTaskStatus, historySummary }) {
  const config = await readJson(path.join(root, 'config.local.json'), {});
  let readiness;
  try { readiness = await automationReadiness(directory, config); }
  catch { readiness = { ready: false, reason: 'Validation evidence is unreadable. Inspect local setup.' }; }
  const scheduler = await taskStatus(root);
  const channel = config.browserChannel ?? 'msedge';
  let sessionSaved = false;
  if (['chrome', 'msedge'].includes(channel)) {
    try { await fs.access(path.join(directory, 'browser', channel)); sessionSaved = true; } catch { /* No session yet. */ }
  }
  const account = { sessionSaved, browser: channel === 'chrome' ? 'Chrome' : 'Edge' };
  let setup;
  try { setup = verificationStatus(await readVerification(directory), config); } catch { setup = { liveChecksPassed: false }; }
  try {
    const state = await readJson(path.join(directory, 'state.json'), {});
    const pending = publicCycleStatus(await readJson(path.join(directory, 'pending-cycle.json'), null));
    const budget = budgetStatus(await readJson(path.join(directory, 'budget.json'), null), now);
    const testSession = await readJson(path.join(directory, 'minute-test.json'), null);
    if (testSession) validateTestSession(testSession);
    if (!pending.pendingCycle && testSession?.lastAttemptAt) {
      const next = Date.parse(testSession.lastAttemptAt) + config.minimumIntervalMinutes * 60000;
      if (next > now && next > (Date.parse(budget.nextEligibleAt) || 0)) {
        budget.nextEligibleAt = new Date(next).toISOString();
        budget.budgetState = 'completed';
      }
    }
    const metrics = historySummary ? await historySummary(now) : summarizeHistory(await readHistory(directory), now);
    return { enabled: config.enabled === true, readiness, scheduler, account, setup, localStateValid: true,
      lastOutcome: ['running', 'success', 'failed'].includes(state.status) ? state.status : 'never-run',
      pendingCycle: pending.pendingCycle, restorationRequired: pending.restorationRequired,
      ...budget, ...metrics };
  } catch {
    return { enabled: config.enabled === true, readiness: { ready: false, reason: 'Local state is unreadable; inspect recovery and history.' },
      scheduler, account, setup, localStateValid: false };
  }
}
