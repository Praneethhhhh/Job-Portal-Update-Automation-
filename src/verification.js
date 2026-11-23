import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireControlLock, acquireLock, readJson, validate, writeJson } from './core.js';
import { publicCycleStatus, runCycle } from './cycle.js';
import { budgetStatus } from './budget.js';
import { readHistory } from './history.js';

const kinds = ['visibleDryRun', 'backgroundDryRun', 'supervisedCycle'];
const selectors = ['edit', 'editor', 'heading', 'name', 'close', 'save', 'success', 'challenge', 'validationError'];

// Activation may change between checks. Evidence is tied to the actual controls,
// browser and timeout, and never contains selectors, URLs or profile values.
export function configurationId(config) {
  return createHash('sha256').update(JSON.stringify({
    profileUrl: config.profileUrl, browser: config.browserChannel ?? 'msedge',
    confirmationMode: config.confirmationMode ?? 'toast-and-editor',
    postSaveDelayMs: config.postSaveDelayMs ?? 5000,
    timeoutMs: config.timeoutMs, minimumIntervalMinutes: config.minimumIntervalMinutes,
    selectors: Object.fromEntries(selectors.map(key => [key, config.selectors?.[key]]))
  })).digest('hex');
}

export async function readVerification(directory) {
  const report = await readJson(path.join(directory, 'validation.json'), { version: 1, checks: {} });
  if (report?.version !== 1 || !report.checks || typeof report.checks !== 'object' || Array.isArray(report.checks) ||
      Object.entries(report.checks).some(([kind, row]) => !kinds.includes(kind) || !row ||
        !['passed', 'failed', 'skipped'].includes(row.status) ||
        !/^[a-f0-9]{64}$/.test(row.configurationId) || !Number.isFinite(Date.parse(row.at)))) {
    throw new Error('Invalid validation evidence');
  }
  return report;
}

export function verificationStatus(report, config) {
  const id = configurationId(config);
  const checks = Object.fromEntries(kinds.map(kind => [kind,
    report.checks[kind]?.configurationId === id &&
      (kind !== 'supervisedCycle' || report.checks[kind].headless === (config.headless === true))
      ? report.checks[kind].status : 'not-verified'
  ]));
  const requiredDryRun = config.headless === true ? 'backgroundDryRun' : 'visibleDryRun';
  return { ...checks, requiredDryRun, liveChecksPassed: checks[requiredDryRun] === 'passed' && checks.supervisedCycle === 'passed' };
}

// Caller holds the shared lock. Only fixed fields reach disk; browser errors and
// adapter return values may contain personal data and are never copied here.
async function record(directory, config, kind, status) {
  const report = await readVerification(directory);
  report.checks[kind] = { configurationId: configurationId(config), status, at: new Date().toISOString(),
    ...(kind === 'supervisedCycle' ? { headless: config.headless === true } : {}) };
  // Re-running an earlier step invalidates the later live-save result.
  const supervised = report.checks.supervisedCycle;
  if (supervised && kind === (supervised.headless ? 'backgroundDryRun' : 'visibleDryRun')) {
    delete report.checks.supervisedCycle;
  }
  await writeJson(path.join(directory, 'validation.json'), report);
  return { check: kind, outcome: status, ...verificationStatus(report, config) };
}

export async function verifyDryRun({ directory, config, adapter, background = false, readConfig }) {
  validate(config, false, { readOnly: true });
  await fs.mkdir(directory, { recursive: true });
  const release = await acquireLock(directory);
  const kind = background ? 'backgroundDryRun' : 'visibleDryRun';
  try {
    await readVerification(directory);
    let status = 'failed';
    try {
      const result = await adapter.dryRun();
      if (result?.outcome === 'dry-run-passed' && configurationId(await readConfig()) === configurationId(config)) status = 'passed';
    } catch { /* Persist a redacted failure, including interrupted authentication. */ }
    return await record(directory, config, kind, status);
  } finally {
    try { await adapter.close(); } finally { await release(); }
  }
}

export async function verifyCycle({ directory, config, adapter, readConfig }) {
  validate(config, true);
  const evidence = verificationStatus(await readVerification(directory), config);
  if (evidence[evidence.requiredDryRun] !== 'passed') {
    return { check: 'supervisedCycle', outcome: 'skipped', reason: 'complete-configured-dry-run-first' };
  }
  const before = new Set((await readHistory(directory)).map(row => row.eventId));
  let result;
  try {
    // Exactly one attempt. Validation never waits for or launches another retry;
    // a failed save leaves the normal durable recovery and budget intact.
    result = await runCycle({ directory, adapter, minimumIntervalMinutes: config.minimumIntervalMinutes, closeAdapter: true,
      lockReservation: () => acquireControlLock(directory),
      authorize: async () => {
        const latest = await readConfig();
        return latest.enabled === true && latest.permissionConfirmed === true && configurationId(latest) === configurationId(config) &&
          (latest.headless === true) === (config.headless === true);
      }
    });
  } finally { await adapter.close(); }
  const release = await acquireLock(directory);
  try {
    const history = (await readHistory(directory)).filter(row => !before.has(row.eventId));
    // Restoring a prior journal is useful but cannot certify a new two-save run.
    const completed = history.find(row => row.outcome === 'cycle-completed' && row.cycleId === result.cycleId &&
      history.some(start => start.outcome === 'attempt-started' && start.action === 'cycle' && start.attemptId === row.attemptId));
    const latest = await readConfig();
    const unchanged = configurationId(latest) === configurationId(config) && (latest.headless === true) === (config.headless === true);
    const status = result.outcome === 'restored' && completed && unchanged ? 'passed' :
      ['skipped', 'nothing-to-recover'].includes(result.outcome) ? 'skipped' : 'failed';
    // A cooldown skip does not erase a previous successful validation.
    if (status === 'skipped') return { check: 'supervisedCycle', ...result };
    const recorded = await record(directory, config, 'supervisedCycle', status);
    return result.outcome === 'failed' ? { ...recorded, reason: result.reason } : recorded;
  } finally { await release(); }
}

export async function checkSetup({ root, directory }) {
  const checks = [];
  const add = (check, passed, next) => checks.push({ check, status: passed ? 'passed' : 'needs-attention', ...(!passed ? { next } : {}) });
  add('node-version', Number(process.versions.node.split('.')[0]) >= 22, 'Install Node.js 22 or newer.');
  let config;
  try {
    config = await readJson(path.join(root, 'config.local.json'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid configuration');
  }
  catch { config = null; add('configuration', false, 'Copy config.example.json to config.local.json and configure it.'); }
  if (config) {
    try { validate(config); add('configuration', true); }
    catch { add('configuration', false, 'Check the profile URL, browser, interval, timeout and all eight selectors.'); }
    add('site-permission', config.permissionConfirmed === true, 'Confirm site permission manually before setting permissionConfirmed to true.');
    add('activation', config.enabled === true, 'Keep Off until ready for a supervised save; set enabled to true for that check.');
    try { await fs.access(path.join(directory, 'browser', config.browserChannel ?? 'msedge')); add('browser-session-directory', true); }
    catch { add('browser-session-directory', false, 'Run npm run login. A session directory alone does not prove authentication.'); }
  }
  let localStateValid = true;
  try {
    const pending = publicCycleStatus(await readJson(path.join(directory, 'pending-cycle.json'), null));
    add('pending-recovery', !pending.pendingCycle, 'Use npm run status and reconcile pending recovery before a new validation cycle.');
    const budget = budgetStatus(await readJson(path.join(directory, 'budget.json'), null));
    checks.push({ check: 'attempt-budget', status: ['ready', 'retry-ready'].includes(budget.budgetState) ? 'passed' : 'needs-attention', ...budget });
    await readHistory(directory);
    add('local-state', true);
  } catch { localStateValid = false; add('local-state', false, 'Inspect local state; do not delete journals or budgets to bypass recovery.'); }
  try { await fs.access(path.join(directory, 'run.lock')); add('run-lock', false, 'Wait for the active command. Only remove a stale lock after checking its PID.'); }
  catch (error) { add('run-lock', error.code === 'ENOENT', 'Check access to the local run lock.'); }
  let verification = { liveChecksPassed: false };
  try { if (config) verification = verificationStatus(await readVerification(directory), config); }
  catch { localStateValid = false; add('validation-evidence', false, 'Inspect .local/validation.json; malformed evidence cannot establish readiness.'); }
  return { outcome: 'setup-report', checks, verification, localStateValid, scheduler: 'not-checked',
    next: 'Run npm run verify, then npm run verify -- --background. After manual permission confirmation and activation, npm run verify-save performs real edits.' };
}
