import fs from 'node:fs/promises';
import path from 'node:path';

const outcomes = new Set(['attempt-started', 'cycle-failed', 'recovery-failed', 'cycle-completed', 'recovery-restored']);

export async function readHistory(directory) {
  let raw;
  try { raw = await fs.readFile(path.join(directory, 'history.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try {
    return raw.split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line);
      if (row.version !== 1 || typeof row.eventId !== 'string' || typeof row.cycleId !== 'string' ||
          !outcomes.has(row.outcome) || !Number.isFinite(Date.parse(row.at))) throw new Error();
      return row;
    });
  } catch { throw new Error('History is corrupt; manual repair required'); }
}

// Caller holds the shared run lock. Stable event IDs make finalization replay safe.
export async function recordHistory(directory, event) {
  const history = await readHistory(directory);
  if (history.some(row => row.eventId === event.eventId)) return;
  const handle = await fs.open(path.join(directory, 'history.jsonl'), 'a', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, ...event }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
}

export function summarizeHistory(history, now = Date.now(), timezone = 'Asia/Calcutta') {
  const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  const today = day(now);
  const unique = [...new Map(history.map(row => [row.eventId, row])).values()];
  const completed = [...new Map(unique.filter(row => row.outcome === 'cycle-completed').map(row => [row.cycleId, row])).values()];
  const failed = unique.filter(row => ['cycle-failed', 'recovery-failed'].includes(row.outcome));
  return {
    completedToday: completed.filter(row => day(row.at) === today).length,
    completedTotal: completed.length,
    failedToday: failed.filter(row => day(row.at) === today).length,
    failedTotal: failed.length,
    lastCompletedAt: completed.map(row => row.at).sort().at(-1) ?? null,
    timezone
  };
}
