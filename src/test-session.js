export function validateTestSession(session) {
  if (!session || session.version !== 1 || typeof session.id !== 'string' || !session.id ||
      !['running', 'completed', 'failed', 'stopped'].includes(session.status) ||
      !Number.isFinite(Date.parse(session.startedAt)) || !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= Date.parse(session.startedAt) || Date.parse(session.expiresAt) - Date.parse(session.startedAt) > 300000 ||
      !Number.isInteger(session.cyclesStarted) || session.cyclesStarted < 0 || session.cyclesStarted > 2 ||
      !Number.isInteger(session.cyclesCompleted) || session.cyclesCompleted < 0 || session.cyclesCompleted > session.cyclesStarted ||
      (session.lastAttemptAt !== null && !Number.isFinite(Date.parse(session.lastAttemptAt)))) throw new Error('Invalid minute test session');
  return session;
}
