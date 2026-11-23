import { fileURLToPath } from 'node:url';
import { startDashboard } from './dashboard.js';

try {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dashboard = await startDashboard({ root });
  console.log(`Local dashboard: ${dashboard.url}`);
  console.log('Keep this process running to use the dashboard. The Windows runner works independently.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await dashboard.close(); });
} catch {
  console.error('Dashboard could not start. Check local files and whether port 4317 is already in use.');
  process.exitCode = 1;
}
