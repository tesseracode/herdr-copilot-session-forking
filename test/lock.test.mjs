import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { acquireSourceLock } from '../src/lock.mjs';

test('atomic same-source lock excludes duplicates and releases only owned files', async () => {
  const dir = resolve(`.test-state-${randomUUID()}`);
  try {
    await mkdir(dir, { mode: 0o700 });
    const release = await acquireSourceLock(dir, 'source-session', '/copilot');
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const [lockDir] = await readdir(dir);
    assert.equal((await stat(join(dir, lockDir))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, lockDir, 'owner.json'))).mode & 0o777, 0o600);
    await assert.rejects(acquireSourceLock(dir, 'source-session', '/copilot'), (error) => {
      assert.equal(error.code, 'source_locked');
      assert.match(error.message, /manually remove only/);
      assert.equal(error.lockPath, join(dir, lockDir));
      return true;
    });
    await assert.rejects(acquireSourceLock(dir, 'source-session', '/another-home'),
      { code: 'source_locked' });
    const otherRelease = await acquireSourceLock(dir, 'other-session', '/copilot');
    await otherRelease();
    await release();
    assert.deepEqual(await readdir(dir), []);
    const reacquired = await acquireSourceLock(dir, 'source-session', '/copilot');
    await reacquired();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('relative state directory is rejected', async () => {
  await assert.rejects(acquireSourceLock('./state', 'source-session', '/copilot'),
    { code: 'invalid_state_dir' });
});
