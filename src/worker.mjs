import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { forkWithClient } from './native-fork.mjs';
import { ForkError } from './errors.mjs';

process.once('disconnect', () => {
  // This worker is the leader of the plugin's private helper process group.
  process.kill(-process.pid, 'SIGKILL');
});

process.once('message', async ({ sourceId, cwd, copilotHome, runtimeBinary }) => {
  try {
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: runtimeBinary, env: { ...process.env } }),
      workingDirectory: cwd,
      baseDirectory: copilotHome,
      logLevel: 'none',
    });
    const childSessionId = await forkWithClient(client, sourceId, {
      onForked: (id) => process.send({ type: 'forked', childSessionId: id }),
      beforeFork: () => new Promise((resolve, reject) => {
        process.once('message', (message) => {
          if (message?.type === 'fork') resolve();
          else reject(new ForkError(message?.code ?? 'source_changed',
            message?.message ?? 'Source revalidation refused the fork.'));
        });
        process.send({ type: 'ready' });
      }),
    });
    process.send({ type: 'result', ok: true, childSessionId }, () => process.exit(0));
  } catch (error) {
    process.send({ type: 'result', ok: false, code: error.code ?? 'helper_failed',
      message: error.code ? error.message : 'Copilot helper failed; inspect sessions before retrying.',
    }, () => process.exit(1));
  }
});
