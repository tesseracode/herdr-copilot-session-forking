import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function packSource(root = projectRoot, outputDir = join(root, 'dist')) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^[a-z0-9-]+$/.test(manifest.name ?? '')
      || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(manifest.version ?? '')
      || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Source packaging requires a valid name, version and explicit files allowlist.');
  }
  const files = [...new Set(['package.json', '.gitignore', ...manifest.files])].sort();
  for (const file of files) {
    if (typeof file !== 'string' || isAbsolute(file) || !/^[a-zA-Z0-9._/-]+$/.test(file)
        || file.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Every release input must be an explicit, relative file path without globs.');
    }
    let path = root;
    for (const part of file.split('/')) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(`Release inputs must not contain symlinks: ${file}`);
      }
    }
    if (!(await lstat(path)).isFile()) {
      throw new Error(`Release input is not a regular file: ${file}`);
    }
  }

  const { stdout: tarVersion } = await exec('tar', ['--version']);
  if (!tarVersion.includes('GNU tar')) throw new Error('Source packaging requires GNU tar.');
  await mkdir(outputDir, { recursive: true });
  const archive = join(outputDir, `${manifest.name}-${manifest.version}.tar.gz`);
  const checksum = `${archive}.sha256`;
  for (const path of [archive, checksum]) {
    const existing = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) throw new Error('Release output already exists; choose a new version or output directory.');
  }
  // Normalize archive metadata so local usernames and timestamps do not ship.
  const { stdout } = await exec('tar', [
    '--format=ustar', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0',
    '-czf', '-', '--', ...files,
  ], {
    cwd: root,
    env: { ...process.env, TAR_OPTIONS: '', COPYFILE_DISABLE: '1' },
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  await writeFile(archive, stdout, { flag: 'wx' });
  const digest = createHash('sha256').update(stdout).digest('hex');
  await writeFile(checksum, `${digest}  ${basename(archive)}\n`, { flag: 'wx' });
  return { archive, checksum, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('Usage: npm run pack:source (no arguments).');
  const result = await packSource();
  console.log(JSON.stringify({ archive: basename(result.archive), checksum: basename(result.checksum) }));
}
