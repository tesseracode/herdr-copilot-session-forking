import { isAbsolute } from 'node:path';
import { createHerdr } from './herdr.mjs';

export async function reportOutcome(outcome, { env = process.env, herdr } = {}) {
  if (outcome.status === 'ready') return outcome;
  if (!isAbsolute(env.HERDR_BIN_PATH ?? '')) {
    return { ...outcome, notification: 'unavailable' };
  }
  const call = herdr ?? createHerdr(env.HERDR_BIN_PATH, env);
  const title = outcome.status === 'error' ? 'Copilot fork stopped' : 'Copilot fork needs attention';
  const body = outcome.paneId
    ? `Inspect ${outcome.paneId} manually. Child identity ${outcome.identityVerified ? 'verified' : 'not confirmed'}. Do not fork again or resume it elsewhere. See the plugin log for details.`
    : `No completed handoff (${outcome.code ?? outcome.status}). Inspect the plugin log before retrying.`;
  try {
    await call(['notification', 'show', title, '--body', body, '--sound', 'none']);
    return { ...outcome, notification: 'shown' };
  } catch {
    return { ...outcome, notification: 'failed',
      notificationWarning: 'The Herdr notification could not be shown; inspect this action result in the plugin log.' };
  }
}
