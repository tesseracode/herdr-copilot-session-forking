import test from 'node:test';
import assert from 'node:assert/strict';
import { reportOutcome } from '../src/report.mjs';

test('verified ready child needs no attention notification', async () => {
  const outcome = { status: 'ready' };
  assert.equal(await reportOutcome(outcome, {
    herdr: () => { throw new Error('must not notify'); },
  }), outcome);
});

for (const status of ['waiting_for_user', 'identity_pending', 'error']) {
  test(`${status} has a visible notification without any agent input`, async () => {
    const calls = [];
    const outcome = await reportOutcome({ status, paneId: 'w1:p2', identityVerified: false }, {
      env: { HERDR_BIN_PATH: '/bin/herdr' },
      herdr: async (args) => { calls.push(args); return {}; },
    });
    assert.equal(outcome.notification, 'shown');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ['notification', 'show']);
    assert.match(calls[0][4], /identity not confirmed/);
    assert.match(calls[0][4], /Do not fork again/);
  });
}

test('notification failure is explicit and preserves the existing child result', async () => {
  const outcome = await reportOutcome({ status: 'identity_pending', childSessionId: 'child' }, {
    env: { HERDR_BIN_PATH: '/bin/herdr' },
    herdr: async () => { throw new Error('do not expose runtime logs'); },
  });
  assert.equal(outcome.childSessionId, 'child');
  assert.equal(outcome.notification, 'failed');
  assert.match(outcome.notificationWarning, /could not be shown/);
});

test('outside Herdr the error remains explicit even when notification is unavailable', async () => {
  const result = await reportOutcome({ status: 'error', code: 'invalid_context' }, { env: {} });
  assert.equal(result.code, 'invalid_context');
  assert.equal(result.notification, 'unavailable');
});
