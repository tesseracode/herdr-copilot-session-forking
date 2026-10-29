import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseHerdrResponse, createHerdr } from '../src/herdr.mjs';

test('parse successful Herdr JSON result', () => {
  assert.deepEqual(parseHerdrResponse({ code: 0, stdout: '{"result":{"pane":{"pane_id":"w1:p2"}}}' }),
    { pane: { pane_id: 'w1:p2' } });
});

for (const [label, input, code] of [
  ['malformed', { code: 0, stdout: 'not JSON' }, 'invalid_herdr_json'],
  ['empty', { code: 0, stdout: '' }, 'invalid_herdr_json'],
  ['missing result', { code: 0, stdout: '{}' }, 'invalid_herdr_response'],
  ['null result', { code: 0, stdout: '{"result":null}' }, 'invalid_herdr_response'],
  ['error on exit zero', { code: 0, stdout: '{"error":{"code":"agent_not_ready","message":"private"}}' }, 'agent_not_ready'],
  ['error on exit one', { code: 1, stderr: '{"error":{"code":"agent_not_ready"}}' }, 'agent_not_ready'],
  ['unknown failing output', { code: 2, stderr: 'private error text' }, 'herdr_failed'],
  ['success with failing exit', { code: 1, stderr: '{"result":{}}' }, 'invalid_herdr_response'],
]) {
  test(`parse ${label}`, () => {
    assert.throws(() => parseHerdrResponse(input), (error) => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes('private'));
      return true;
    });
  });
}

function spawnFixture(onSpawn) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.emit('close', null); return true; };
    queueMicrotask(() => onSpawn(child));
    return child;
  };
}

test('subprocess wrapper checks stdout JSON errors with zero exit', async () => {
  const call = createHerdr('/herdr', {}, { spawnProcess: spawnFixture((child) => {
    child.stdout.end('{"error":{"code":"agent_not_ready"}}');
    child.emit('close', 0);
  }) });
  await assert.rejects(call(['agent', 'start']), { code: 'agent_not_ready' });
});

test('subprocess deadline never retries the command', async () => {
  let launches = 0;
  const spawnProcess = spawnFixture(() => { launches++; });
  const call = createHerdr('/herdr', {}, { spawnProcess, timeoutMs: 5 });
  await assert.rejects(call(['pane', 'split']), { code: 'herdr_timeout' });
  assert.equal(launches, 1);
});

test('pane run alone permits an empty successful acknowledgement', async () => {
  const call = createHerdr('/herdr', {}, { spawnProcess: spawnFixture((child) => {
    child.emit('close', 0);
  }) });
  assert.deepEqual(await call(['pane', 'run', 'w1:p2', 'command'], { allowEmptyResult: true }), {});
  await assert.rejects(call(['pane', 'get', 'w1:p2'], { allowEmptyResult: true }),
    { code: 'invalid_herdr_json' });
});

for (const stream of ['stdout', 'stderr']) {
  test(`pane run never ignores exit-zero JSON error on ${stream}`, async () => {
    const call = createHerdr('/herdr', {}, { spawnProcess: spawnFixture((child) => {
      child[stream].end('{"error":{"code":"agent_not_ready"}}');
      child.emit('close', 0);
    }) });
    await assert.rejects(call(['pane', 'run', 'w1:p2', 'command'], { allowEmptyResult: true }),
      { code: 'agent_not_ready' });
  });
}

test('pane run still rejects unsuccessful empty response', async () => {
  const call = createHerdr('/herdr', {}, { spawnProcess: spawnFixture((child) => {
    child.emit('close', 1);
  }) });
  await assert.rejects(call(['pane', 'run', 'w1:p2', 'command'], { allowEmptyResult: true }),
    { code: 'herdr_failed' });
});
