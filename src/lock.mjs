import { createHash } from 'node:crypto';
import { mkdir, lstat, chmod, writeFile, unlink, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ForkError } from './errors.mjs';

export async function acquireSourceLock(stateDir, sourceId) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) {
    throw new ForkError('invalid_state_dir', 'HERDR_PLUGIN_STATE_DIR must be an absolute private directory.');
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const info = await lstat(stateDir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) {
    throw new ForkError('unsafe_state_dir', 'Plugin state must be a user-owned directory, not a symlink.');
  }
  if ((info.mode & 0o077) !== 0) await chmod(stateDir, 0o700);
  const hash = createHash('sha256').update(sourceId).digest('hex');
  const lockPath = join(stateDir, `fork-${hash}.lock`);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new ForkError('source_locked',
      'A fork of this source is locked. Inspect owner.json, confirm its PID has exited, then manually remove only that stale lock directory.',
      { lockPath });
  }
  try {
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid, createdAt: new Date().toISOString(),
    }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rmdir(lockPath);
    throw error;
  }
  return async () => {
    await unlink(join(lockPath, 'owner.json'));
    await rmdir(lockPath);
  };
}
