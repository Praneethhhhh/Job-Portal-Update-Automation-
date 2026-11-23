import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { acquireLock, readJson, writeJson } from './core.js';
import { automationReadiness, operationStatus } from './operation.js';

export async function startDashboard({ root, directory = path.join(root, '.local'), port = 4317, taskStatus }) {
  await fs.mkdir(directory, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const assets = new Map(await Promise.all([
    ['/', 'dashboard.html', 'text/html'], ['/dashboard.css', 'dashboard.css', 'text/css'], ['/dashboard.js', 'dashboard.js', 'text/javascript']
  ].map(async ([url, file, type]) => [url, { body: await fs.readFile(path.join(root, 'web', file)), type }])));
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
      req.resume(); return json(403, { error: 'Local requests only.' });
    }
    try {
      if (req.method === 'GET' && assets.has(req.url)) {
        const asset = assets.get(req.url);
        res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8` }); return res.end(asset.body);
      }
      if (req.method === 'GET' && req.url === '/api/status') {
        return json(200, { ...await operationStatus({ root, directory, taskStatus }), token });
      }
      if (req.method !== 'POST' || req.url !== '/api/activation') return json(404, { error: 'Not found.' });
      const received = Buffer.from(typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '');
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' ||
          received.length !== token.length || !timingSafeEqual(received, Buffer.from(token))) {
        req.resume(); return json(403, { error: 'Invalid local control request. Refresh this page.' });
      }
      let body = '', size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size <= 4096) body += chunk;
      }
      if (size > 4096) return json(413, { error: 'Request too large.' });
      let change;
      try { change = JSON.parse(body); } catch { return json(400, { error: 'Invalid activation request.' }); }
      if (!change || typeof change.enabled !== 'boolean' || Object.keys(change).some(key => !['enabled', 'unattendedConfirmed'].includes(key)) ||
          ('unattendedConfirmed' in change && (change.unattendedConfirmed !== true || change.enabled !== true))) return json(400, { error: 'Expected an On/Off value and optional explicit unattended confirmation.' });
      // Separate from run.lock: Off must be writable during a reserved cycle.
      const release = await acquireLock(path.join(directory, 'control'));
      try {
        const configFile = path.join(root, 'config.local.json');
        const config = await readJson(configFile);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
        if (change.enabled) {
          const readiness = await automationReadiness(directory, { ...config, ...(change.unattendedConfirmed === true ? { unattendedConfirmed: true } : {}) });
          if (!readiness.ready) return json(409, { error: readiness.reason });
          // Corrupt state must not be reactivated by a healthy config alone.
          if (!(await operationStatus({ root, directory, taskStatus })).localStateValid) return json(409, { error: 'Inspect local state before enabling.' });
        }
        await writeJson(configFile, { ...config, enabled: change.enabled, ...(change.unattendedConfirmed === true ? { unattendedConfirmed: true } : {}) });
        return json(200, { enabled: change.enabled });
      } finally { await release(); }
    } catch (error) {
      json(error.code === 'EEXIST' ? 409 : 503, { error: 'Local state is unavailable or busy. Check setup and try again.' });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await fs.mkdir(path.join(directory, 'control'), { recursive: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin, close: () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
  }) };
}
