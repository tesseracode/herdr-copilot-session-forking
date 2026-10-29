import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ForkError, bounded } from './errors.mjs';

export function sanitizeHelperEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    value !== undefined && !key.startsWith('HERDR_')));
}

export async function forkWithClient(client, sourceId, {
  startMs = 100_000, forkMs = 30_000, stopMs = 10_000,
  onForked = () => {},
  beforeFork = async () => {},
} = {}) {
  let childSessionId;
  let failure;
  try {
    await bounded(() => client.start(), startMs, 'Copilot helper startup');
    await bounded(beforeFork, 15_000, 'Source revalidation');
    let result;
    try {
      result = await bounded(() => client.rpc.sessions.fork({ sessionId: sourceId }), forkMs, 'Native fork');
    } catch {
      throw new ForkError('fork_uncertain',
        'Native fork failed or disconnected; a child may exist. Inspect Copilot sessions before retrying. The source was not resumed.');
    }
    const id = result?.sessionId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) || id === sourceId) {
      throw new ForkError('invalid_child_id', 'Native fork did not return a distinct valid child session ID.');
    }
    childSessionId = id;
    onForked(id);
  } catch (error) {
    failure = error instanceof ForkError ? error :
      new ForkError('helper_failed', 'Copilot helper failed. No source resume or launch was attempted.');
  } finally {
    try {
      const errors = await bounded(() => client.stop(), stopMs, 'Copilot helper shutdown');
      if (Array.isArray(errors) && errors.length) {
        throw new ForkError('helper_stop_failed', 'Copilot helper reported shutdown errors.');
      }
    } catch {
      try {
        await bounded(() => client.forceStop(), stopMs, 'Copilot helper forced shutdown');
      } catch {
        failure = new ForkError('helper_cleanup_failed', 'Could not confirm helper shutdown; child launch was refused.');
      }
      failure ??= new ForkError('helper_stop_failed', 'Helper required forced shutdown; child launch was refused.');
    }
  }
  if (failure) {
    if (childSessionId) failure.childSessionId = childSessionId;
    throw failure;
  }
  return childSessionId;
}

// Isolate runtime logs and give the helper its own process group. Only this owned
// group is terminated on timeout; no source process or session lock is touched.
export function forkNative(options, { spawnProcess = spawn, timeoutMs = 170_000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = spawnProcess(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
      cwd: options.cwd,
      env: sanitizeHelperEnv(options.env),
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let childSessionId;
    let response;
    let finished = false;
    let forkAuthorized = false;
    const cleanupGroup = () => {
      if (!worker.pid) return;
      try {
        process.kill(-worker.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const fail = (code, message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
      try {
        cleanupGroup();
      } catch {
        message += ' Could not confirm owned helper process cleanup.';
      }
      reject(new ForkError(code, message, { childSessionId }));
    };
    const interrupted = () => fail('interrupted', 'Fork interrupted; inspect sessions before retrying.');
    const timer = setTimeout(() => fail('helper_timeout',
      'Helper timed out; a child may exist. Inspect Copilot sessions before retrying.'), timeoutMs);
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    worker.on('message', (message) => {
      if (message?.type === 'forked') childSessionId = message.childSessionId;
      if (message?.type === 'result') response = message;
      if (message?.type === 'ready' && !forkAuthorized) {
        forkAuthorized = true;
        Promise.resolve().then(() => options.beforeFork?.()).then(
          () => {
            if (!finished) worker.send({ type: 'fork' }, (error) => {
              if (error) fail('helper_ipc_failed', 'Could not authorize the native fork; inspect sessions before retrying.');
            });
          },
          (error) => {
            if (!finished) worker.send({ type: 'deny', code: error.code ?? 'source_changed',
              message: error instanceof ForkError ? error.message : 'Source revalidation failed.',
            }, (sendError) => {
              if (sendError) fail('helper_ipc_failed', 'Could not cancel the helper; inspect sessions before retrying.');
            });
          },
        );
      }
    });
    worker.once('error', () => fail('helper_spawn_failed', 'Could not start the private Copilot helper.'));
    worker.once('close', (code) => {
      if (finished) return;
      if (code !== 0 || !response?.ok || response.childSessionId !== childSessionId) {
        fail(response?.code ?? 'helper_failed',
          response?.message ?? 'Helper exited unexpectedly; a child may exist. Inspect sessions before retrying.');
        return;
      }
      finished = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
      resolve(childSessionId);
    });
    worker.send({ sourceId: options.sourceId, cwd: options.cwd, copilotHome: options.copilotHome,
      runtimeBinary: options.runtimeBinary }, (error) => {
      if (error) fail('helper_ipc_failed', 'Helper communication failed; no retry was attempted.');
    });
  });
}
