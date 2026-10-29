import { spawn } from 'node:child_process';
import { ForkError } from './errors.mjs';

export function parseHerdrResponse({ code, stdout = '', stderr = '' }, { allowEmptyResult = false } = {}) {
  let text = (code === 0 ? stdout : stderr).trim();
  if (code === 0 && allowEmptyResult && !text) {
    if (!stderr.trim()) return {};
    text = stderr.trim();
  }
  let response;
  try {
    response = JSON.parse(text);
  } catch {
    throw new ForkError(code === 0 ? 'invalid_herdr_json' : 'herdr_failed',
      code === 0 ? 'Herdr returned malformed JSON.' : 'Herdr command failed; no operation was retried.');
  }
  if (response?.error) {
    const rawCode = response.error.code;
    const errorCode = typeof rawCode === 'string' && /^[a-z0-9_]{1,64}$/.test(rawCode)
      ? rawCode : 'herdr_error';
    throw new ForkError(errorCode, `Herdr reported ${errorCode}; no operation was retried.`);
  }
  if (code !== 0 || !response || typeof response.result !== 'object' || response.result === null) {
    throw new ForkError('invalid_herdr_response', 'Herdr did not return a successful result.');
  }
  return response.result;
}

export function createHerdr(binary, env, { spawnProcess = spawn, timeoutMs = 12_000 } = {}) {
  return (args, { timeout = timeoutMs, allowEmptyResult = false } = {}) => new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failed = false;
    const fail = (code, message) => {
      if (failed) return;
      failed = true;
      child.kill('SIGKILL');
      reject(new ForkError(code, message));
    };
    const timer = setTimeout(() => fail('herdr_timeout',
      'Herdr command timed out; its outcome is uncertain. Inspect existing panes before retrying.'), timeout);
    for (const [stream, append] of [
      [child.stdout, (text) => { stdout += text; }],
      [child.stderr, (text) => { stderr += text; }],
    ]) {
      stream.on('data', (data) => {
        append(data.toString());
        if (stdout.length + stderr.length > 1_048_576) {
          fail('herdr_output_limit', 'Herdr output exceeded the safety limit.');
        }
      });
    }
    child.once('error', () => {
      clearTimeout(timer);
      failed = true;
      reject(new ForkError('herdr_spawn_failed', 'Could not execute HERDR_BIN_PATH.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      try {
        resolve(parseHerdrResponse({ code, stdout, stderr }, {
          allowEmptyResult: allowEmptyResult && args[0] === 'pane' && args[1] === 'run',
        }));
      } catch (error) {
        reject(error);
      }
    });
  });
}
