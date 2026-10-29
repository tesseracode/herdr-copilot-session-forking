import { runFork, SAFETY_NOTE } from './fork.mjs';
import { reportOutcome } from './report.mjs';

try {
  const result = await reportOutcome(await runFork(process.argv[2]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const result = { status: 'error', code: error.code ?? 'action_failed',
    message: error.code ? error.message : 'Fork action failed.',
    warning: SAFETY_NOTE };
  for (const key of ['childSessionId', 'paneId', 'resumeCommand', 'recovery', 'lockPath', 'lockCleanupFailed', 'launcher']) {
    if (error[key] !== undefined) result[key] = error[key];
  }
  process.stderr.write(`${JSON.stringify(await reportOutcome(result))}\n`);
  process.exitCode = 1;
}
