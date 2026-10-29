import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { forkWithClient, forkNative, sanitizeHelperEnv } from '../src/native-fork.mjs';

function clientFixture(overrides = {}) {
  const calls = [];
  const client = {
    start: async () => { calls.push('start'); },
    rpc: { sessions: { fork: async (params) => {
      calls.push(['fork', params]);
      return { sessionId: 'child-session' };
    } } },
    stop: async () => { calls.push('stop'); return []; },
    forceStop: async () => { calls.push('forceStop'); },
    ...overrides,
  };
  return { client, calls };
}

test('helper scrub removes every Herdr identity while preserving authentication', () => {
  const original = {
    HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/socket',
    HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1',
    HERDR_PLUGIN_CONTEXT_JSON: '{}', HERDR_BIN_PATH: '/herdr',
    GH_TOKEN: 'unit-test-placeholder', GITHUB_TOKEN: 'test-only',
    PATH: '/bin', COPILOT_HOME: '/copilot', UNSET: undefined,
  };
  const clean = sanitizeHelperEnv(original);
  assert.deepEqual(clean, { GH_TOKEN: 'unit-test-placeholder', GITHUB_TOKEN: 'test-only',
    PATH: '/bin', COPILOT_HOME: '/copilot' });
  assert.equal(original.HERDR_ENV, '1');
});

test('official fork API gets only the source ID and helper stops before return', async () => {
  const { client, calls } = clientFixture();
  const id = await forkWithClient(client, 'source-session');
  assert.equal(id, 'child-session');
  assert.deepEqual(calls, ['start', ['fork', { sessionId: 'source-session' }], 'stop']);
});

test('source is revalidated after costly startup and immediately before native fork', async () => {
  const { client, calls } = clientFixture();
  await forkWithClient(client, 'source-session', {
    beforeFork: async () => { calls.push('revalidate'); },
  });
  assert.deepEqual(calls, ['start', 'revalidate', ['fork', { sessionId: 'source-session' }], 'stop']);
});

test('failed post-start source revalidation never calls fork and still stops', async () => {
  const { client, calls } = clientFixture();
  await assert.rejects(forkWithClient(client, 'source-session', {
    beforeFork: async () => { throw new Error('source busy'); },
  }), { code: 'helper_failed' });
  assert.deepEqual(calls, ['start', 'stop']);
});

for (const sessionId of ['source-session', undefined, '--option', 'bad/id', '']) {
  test(`reject invalid native child ${sessionId}`, async () => {
    const { client, calls } = clientFixture({
      rpc: { sessions: { fork: async () => ({ sessionId }) } },
    });
    await assert.rejects(forkWithClient(client, 'source-session'), { code: 'invalid_child_id' });
    assert.ok(calls.includes('stop'));
  });
}

test('helper start failure is sanitized and stop still runs', async () => {
  const { client, calls } = clientFixture({ start: async () => { throw new Error('secret must not escape'); } });
  await assert.rejects(forkWithClient(client, 'source-session'), (error) => {
    assert.equal(error.code, 'helper_failed');
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  assert.deepEqual(calls, ['stop']);
});

test('uncertain fork is not retried and helper is stopped', async () => {
  let attempts = 0;
  const { client, calls } = clientFixture({
    rpc: { sessions: { fork: async () => { attempts++; throw new Error('disconnect'); } } },
  });
  await assert.rejects(forkWithClient(client, 'source-session'), { code: 'fork_uncertain' });
  assert.equal(attempts, 1);
  assert.ok(calls.includes('stop'));
});

test('native fork timeout is bounded, uncertain, and not retried', async () => {
  const { client, calls } = clientFixture({
    rpc: { sessions: { fork: () => new Promise(() => {}) } },
  });
  await assert.rejects(forkWithClient(client, 'source-session', { forkMs: 5 }), { code: 'fork_uncertain' });
  assert.ok(calls.includes('stop'));
});

test('shutdown failure preserves child and requires forced stop', async () => {
  const { client, calls } = clientFixture({ stop: async () => [new Error('failed')] });
  const ids = [];
  await assert.rejects(forkWithClient(client, 'source-session', { onForked: (id) => ids.push(id) }),
    { code: 'helper_stop_failed', childSessionId: 'child-session' });
  assert.deepEqual(ids, ['child-session']);
  assert.ok(calls.includes('forceStop'));
});

test('shutdown timeout preserves child and cannot launch', async () => {
  const { client, calls } = clientFixture({ stop: () => new Promise(() => {}) });
  await assert.rejects(forkWithClient(client, 'source-session', { stopMs: 5 }),
    { code: 'helper_stop_failed', childSessionId: 'child-session' });
  assert.ok(calls.includes('forceStop'));
});

test('failed forced shutdown reports cleanup uncertainty', async () => {
  const { client } = clientFixture({
    stop: async () => { throw new Error('fail'); },
    forceStop: async () => { throw new Error('fail'); },
  });
  await assert.rejects(forkWithClient(client, 'source-session'),
    { code: 'helper_cleanup_failed', childSessionId: 'child-session' });
});

function workerFixture(run) {
  const worker = new EventEmitter();
  worker.send = (options, callback) => {
    callback();
    queueMicrotask(() => run(worker, options));
  };
  let spawnOptions;
  const spawnProcess = (_command, _args, options) => {
    spawnOptions = options;
    return worker;
  };
  return { spawnProcess, options: () => spawnOptions };
}

test('worker result is accepted only after shutdown process exits', async () => {
  let processExited = false;
  const f = workerFixture((worker, params) => {
    assert.equal(params.sourceId, 'source-session');
    worker.emit('message', { type: 'forked', childSessionId: 'child-session' });
    worker.emit('message', { type: 'result', ok: true, childSessionId: 'child-session' });
    processExited = true;
    worker.emit('close', 0);
  });
  const id = await forkNative({ sourceId: 'source-session', cwd: '/project',
    copilotHome: '/copilot', runtimeBinary: '/copilot-bin', env: { HERDR_ENV: '1', GH_TOKEN: 'test' } }, f);
  assert.equal(id, 'child-session');
  assert.equal(processExited, true);
  assert.equal(f.options().env.HERDR_ENV, undefined);
  assert.equal(f.options().env.GH_TOKEN, 'test');
  assert.equal(f.options().detached, true);
});

test('unexpected worker exit retains any already-created child', async () => {
  const f = workerFixture((worker) => {
    worker.emit('message', { type: 'forked', childSessionId: 'child-session' });
    worker.emit('close', 1);
  });
  await assert.rejects(forkNative({ cwd: '/project', env: {} }, f),
    { code: 'helper_failed', childSessionId: 'child-session' });
});

test('worker handshake rechecks source before authorizing a single fork', async () => {
  const messages = [];
  const worker = new EventEmitter();
  worker.send = (message, callback) => {
    messages.push(message);
    callback();
    queueMicrotask(() => {
      if (message.sourceId) worker.emit('message', { type: 'ready' });
      if (message.type === 'fork') {
        worker.emit('message', { type: 'forked', childSessionId: 'child-session' });
        worker.emit('message', { type: 'result', ok: true, childSessionId: 'child-session' });
        worker.emit('close', 0);
      }
    });
  };
  let rechecked = false;
  assert.equal(await forkNative({ sourceId: 'source-session', cwd: '/project', env: {},
    beforeFork: async () => {
      assert.equal(messages.length, 1);
      rechecked = true;
    },
  }, { spawnProcess: () => worker }), 'child-session');
  assert.equal(rechecked, true);
  assert.equal(messages.filter((message) => message.type === 'fork').length, 1);
});

test('worker handshake denies changed source without authorizing fork', async () => {
  const worker = new EventEmitter();
  const messages = [];
  worker.send = (message, callback) => {
    messages.push(message);
    callback();
    queueMicrotask(() => {
      if (message.sourceId) worker.emit('message', { type: 'ready' });
      if (message.type === 'deny') {
        worker.emit('message', { type: 'result', ok: false, code: 'source_changed',
          message: 'Source revalidation failed.' });
        worker.emit('close', 1);
      }
    });
  };
  await assert.rejects(forkNative({ sourceId: 'source-session', cwd: '/project', env: {},
    beforeFork: async () => { throw new Error('not safe'); },
  }, { spawnProcess: () => worker }), { code: 'source_changed' });
  assert.equal(messages.filter((message) => message.type === 'fork').length, 0);
});
