const $ = id => document.getElementById(id);
const time = value => value ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Calcutta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(value)) : 'No record yet';
const budgetLabels = { ready: 'Ready for an eligible attempt', completed: 'Window completed', 'retry-wait': 'Waiting before the single retry', 'retry-ready': 'Single retry eligible', exhausted: 'Two attempts used · waiting for next window', 'manual-attention': 'Stopped · manual attention required' };
let state, busy = false, loading = false;
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
function render(data) {
  state = data;
  $('activation').setAttribute('aria-checked', String(data.enabled));
  $('activation').disabled = busy;
  $('activation-label').textContent = data.enabled ? 'On' : 'Off';
  $('workflow-title').textContent = data.enabled ? data.readiness.ready ? 'Your workflow is On' : 'Workflow needs attention' : 'Your workflow is Off';
  $('workflow-description').textContent = !data.readiness.ready ? data.readiness.reason : data.enabled ? 'Eligible attempts can run while this computer is awake and signed in.' : 'Ready when you are. Turn On to allow eligible scheduled attempts.';
  $('last-outcome').textContent = { running: 'Attempt in progress', success: 'Original name verified restored', failed: 'Attempt failed · inspect recovery and recent activity', 'never-run': 'No runs yet' }[data.lastOutcome] ?? 'Unavailable';
  $('account-session').textContent = data.account?.sessionSaved ? `Saved ${data.account.browser} session found` : 'Not connected · run npm run login';
  const requiredCheck = data.setup?.requiredDryRun;
  const mode = requiredCheck === 'backgroundDryRun' ? 'Hidden browser' : 'Visible browser';
  $('page-checks').textContent = data.setup?.[requiredCheck] === 'passed' ? `${mode} check passed` : `${mode} check required`;
  $('live-check').textContent = data.setup?.supervisedCycle === 'passed' ? 'Original name verified restored' : 'Not verified yet';
  $('recovery').hidden = !data.restorationRequired;
  for (const [id, key] of [['completed-today','completedToday'],['completed-total','completedTotal'],['failed-today','failedToday'],['failed-total','failedTotal']]) $(id).textContent = data[key] ?? '—';
  $('attempts').replaceChildren(document.createTextNode(data.attemptsUsed ?? '—'), Object.assign(document.createElement('small'), { textContent: ' / 2 attempts' }));
  $('budget-state').textContent = budgetLabels[data.budgetState] ?? 'Local state unavailable';
  $('scheduler').textContent = { enabled: data.scheduler.running ? 'Enabled · runner active' : 'Enabled · runner stopped', paused: 'Paused in Windows', 'not-installed': 'Not installed', unknown: 'Unknown' }[data.scheduler.state] ?? 'Unknown';
  $('scheduler-note').textContent = data.scheduler.state === 'not-installed' ? 'Install after completing supervised validation.' : data.scheduler.state === 'unknown' ? 'Windows scheduler status could not be read.' : 'Independent of this dashboard page.';
  $('next-eligible').textContent = !data.enabled ? 'Paused by workflow switch' :
    !data.readiness.ready ? 'Paused until setup is verified' :
    data.scheduler.state !== 'enabled' || !data.scheduler.running ? 'Waiting for Windows scheduler' :
    data.nextEligibleAt && Date.parse(data.nextEligibleAt) > Date.now() ? time(data.nextEligibleAt) : 'Eligible now';
  $('last-completed').textContent = time(data.lastCompletedAt);
  $('activity').replaceChildren();
  for (const row of data.activity) {
    const tr = document.createElement('tr');
    for (const text of [time(row.at), row.action, row.outcome, row.explanation]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    const badge = document.createElement('span');
    badge.className = `result${/completed|restored/.test(row.outcome) ? ' success' : /failed/.test(row.outcome) ? ' failure' : ''}`;
    badge.textContent = row.outcome; tr.children[2].replaceChildren(badge);
    $('activity').append(tr);
  }
  $('empty').hidden = data.activity.length > 0 || !data.localStateValid;
  $('last-refreshed').textContent = `Updated ${time(Date.now())}`;
  if (!data.localStateValid) showError('Local state is unreadable. Counts are unavailable; inspect setup and recovery before continuing.');
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const data = await response.json();
    showError(''); render(data);
  } catch {
    showError('Cannot reach the local dashboard. Check that npm run dashboard is running, then refresh.');
    $('activation').disabled = true;
    $('last-refreshed').textContent = 'Connection unavailable · displayed values may be stale';
  } finally { loading = false; }
}
$('refresh').addEventListener('click', refresh);
$('activation').addEventListener('click', async () => {
  if (busy || !state) return;
  busy = true; $('activation').disabled = true;
  try {
    const change = { enabled: !state.enabled };
    const response = await fetch('/api/activation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.token }, body: JSON.stringify(change) });
    const result = await response.json();
    if (!response.ok) { showError(result.error); return; }
    render({ ...state, enabled: result.enabled });
  } catch { showError('The change could not be confirmed. Refresh to check the saved On/Off state.'); }
  finally { busy = false; if (state) $('activation').disabled = false; }
});
refresh();
setInterval(refresh, 15000);
