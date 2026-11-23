import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const outcomes = new Set(['attempt-started', 'cycle-failed', 'recovery-failed', 'cycle-completed', 'recovery-restored']);
const pageSize = 20;

function parseEvent(line) {
  const row = JSON.parse(line);
  if (row.version !== 1 || typeof row.eventId !== 'string' || typeof row.cycleId !== 'string' ||
      !outcomes.has(row.outcome) || !Number.isFinite(Date.parse(row.at))) {
    throw new Error('History is corrupt; manual repair required');
  }
  return row;
}

export async function readHistory(directory) {
  let raw;
  try { raw = await fs.readFile(path.join(directory, 'history.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try {
    return raw.split('\n').filter(Boolean).map(parseEvent);
  } catch { throw new Error('History is corrupt; manual repair required'); }
}

// Byte offsets anchor older pages even when new events are appended.
export async function readHistoryPage(directory, before) {
  let handle;
  try { handle = await fs.open(path.join(directory, 'history.jsonl'), 'r'); }
  catch (error) {
    if (error.code === 'ENOENT' && before === undefined) return { rows: [], next: null };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (before !== undefined) {
      if (!Number.isSafeInteger(before) || before < 1 || before > size) throw new RangeError('Invalid history cursor');
      const boundary = Buffer.alloc(1);
      await handle.read(boundary, 0, 1, before - 1);
      if (boundary[0] !== 10) throw new RangeError('Invalid history cursor');
    }
    let position = before ?? size;
    let suffix = Buffer.alloc(0);
    const rows = [];
    let next = null;
    function take(line, start) {
      if (!line.length) return false;
      if (rows.length === pageSize) return true;
      rows.push(parseEvent(line.toString('utf8')));
      next = start;
      return false;
    }
    while (position > 0) {
      const length = Math.min(position, 8192);
      position -= length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead !== length) throw new RangeError('History changed; refresh the activity list');
      const block = Buffer.concat([chunk, suffix]);
      let end = block.length;
      for (let index = end - 1; index >= 0; index--) {
        if (block[index] !== 10) continue;
        if (take(block.subarray(index + 1, end), position + index + 1)) return { rows, next };
        end = index;
      }
      suffix = block.subarray(0, end);
    }
    return { rows, next: take(suffix, 0) ? next : null };
  } finally { await handle.close(); }
}

// Dashboard polls reuse counters while the journal and local date are unchanged.
export function cachedHistorySummary(directory) {
  let cached;
  let revision = 0;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Calcutta', dateStyle: 'short' });
  return async now => {
    const stat = await fs.stat(path.join(directory, 'history.jsonl')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const key = [stat?.ino, stat?.size, stat?.mtimeMs, stat?.ctimeMs, date.format(now)].join(':');
    if (key !== cached?.key) {
      const activityRevision = ++revision;
      const summary = streamHistorySummary(directory, stat?.size ?? 0, now)
        .then(metrics => ({ ...metrics, activityRevision }));
      const entry = { key, summary };
      cached = entry;
      entry.summary.catch(() => { if (cached === entry) cached = undefined; });
    }
    return cached.summary;
  };
}

async function streamHistorySummary(directory, size, now) {
  const counters = historyCounters();
  if (size > 0) {
    const stream = createReadStream(path.join(directory, 'history.jsonl'), { encoding: 'utf8', end: size - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) if (line) counters.add(parseEvent(line));
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return counters.summary(now, 'Asia/Calcutta');
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

function historyCounters() {
  const counted = new Map();
  return {
    add(row) {
      if (row.outcome === 'cycle-completed' || row.outcome === 'cycle-failed' || row.outcome === 'recovery-failed') {
        counted.set(row.eventId, { at: row.at, cycleId: row.cycleId, outcome: row.outcome });
      } else {
        counted.delete(row.eventId);
      }
    },
    summary(now, timezone) {
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
      const today = formatter.format(now);
      const completed = new Map();
      let failedTotal = 0, failedToday = 0, completedToday = 0, lastCompletedAt = null;
      for (const row of counted.values()) {
        if (row.outcome === 'cycle-completed') completed.set(row.cycleId, row.at);
        else {
          failedTotal++;
          if (formatter.format(Date.parse(row.at)) === today) failedToday++;
        }
      }
      for (const at of completed.values()) {
        if (formatter.format(Date.parse(at)) === today) completedToday++;
        if (lastCompletedAt === null || Date.parse(at) > Date.parse(lastCompletedAt)) lastCompletedAt = at;
      }
      return { completedToday, completedTotal: completed.size, failedToday, failedTotal, lastCompletedAt, timezone };
    }
  };
}

export function summarizeHistory(history, now = Date.now(), timezone = 'Asia/Calcutta') {
  const counters = historyCounters();
  for (const row of history) counters.add(row);
  return counters.summary(now, timezone);
}
