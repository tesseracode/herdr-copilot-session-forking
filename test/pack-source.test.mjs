import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packSource } from '../scripts/pack-source.mjs';

const exec = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t, files = ['LICENSE']) {
  const root = await mkdtemp(join(tmpdir(), 'session-forking-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture-plugin', version: '0.2.0', files,
  }));
  await writeFile(join(root, '.gitignore'), 'dist/\n');
  await writeFile(join(root, 'LICENSE'), 'Synthetic fixture license\n');
  return root;
}

test('source package contains only allowlisted files and a portable checksum', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'private.log'), 'Synthetic excluded log\n');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'excluded.txt'), 'Excluded dependency\n');
  const result = await packSource(root);
  const { stdout: listing } = await exec('tar', ['-tzf', result.archive]);
  assert.deepEqual(listing.trim().split('\n').sort(), ['.gitignore', 'LICENSE', 'package.json']);
  const digest = createHash('sha256').update(await readFile(result.archive)).digest('hex');
  assert.equal(await readFile(result.checksum, 'utf8'), `${digest}  ${basename(result.archive)}\n`);
  const { stdout: metadata } = await exec('tar', ['--numeric-owner', '-tvzf', result.archive]);
  for (const line of metadata.trim().split('\n')) assert.match(line, /^\S+\s+0\/0\s/);
  await assert.rejects(packSource(root), /already exists/);
});

for (const file of ['../private.log', '/private.log', 'src/*.mjs', '--checkpoint-action=exec']) {
  test(`source packager rejects unsafe allowlist entry ${file}`, async (t) => {
    await assert.rejects(packSource(await fixture(t, [file])), /explicit, relative file path/);
  });
}

test('source packager rejects symlink inputs and symlink ancestors', async (t) => {
  const root = await fixture(t, ['linked-license']);
  await symlink('LICENSE', join(root, 'linked-license'));
  await assert.rejects(packSource(root), /must not contain symlinks/);
  const nested = await fixture(t, ['linked/contents']);
  await mkdir(join(nested, 'target'));
  await writeFile(join(nested, 'target', 'contents'), 'Synthetic fixture\n');
  await symlink('target', join(nested, 'linked'));
  await assert.rejects(packSource(nested), /must not contain symlinks/);
});

test('actual source release includes the lockfile and excludes private artifacts', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'session-forking-release-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const result = await packSource(projectRoot, output);
  const { stdout } = await exec('tar', ['-tzf', result.archive]);
  assert.deepEqual(stdout.trim().split('\n').sort(), result.files);
  assert.ok(result.files.includes('package-lock.json'));
  assert.ok(result.files.includes('LICENSE'));
  assert.ok(result.files.includes('test/pack-source.test.mjs'));
  assert.ok(result.files.includes('runbooks/compatibility.txt'));
  assert.ok(result.files.every((path) => !/node_modules|\.log$|\.test-state|dist\//.test(path)));
});

test('public package, lockfile, manifest and license use consistent release metadata', async () => {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'));
  const plugin = await readFile(join(projectRoot, 'herdr-plugin.toml'), 'utf8');
  assert.equal(manifest.name, 'herdr-copilot-session-forking');
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(manifest.license, 'MIT');
  assert.equal(lock.packages[''].license, manifest.license);
  assert.equal(manifest.private, true);
  assert.ok(plugin.includes(`version = "${manifest.version}"`));
  assert.ok(plugin.includes('id = "tesseracode.copilot-session-forking"'));
  assert.match(await readFile(join(projectRoot, 'LICENSE'), 'utf8'), /^MIT License\n/);
});

test('security override is SDK-scoped and the lock resolves only patched Zod', async () => {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'));
  assert.deepEqual(manifest.overrides, {
    '@github/copilot-sdk@1.0.28': { zod: '4.6.6' },
  });
  assert.equal(manifest.dependencies['@github/copilot-sdk'], '1.0.28');
  assert.equal(manifest.dependencies['@github/copilot'], '1.0.105');
  const zodEntries = Object.entries(lock.packages)
    .filter(([path]) => /(^|\/)node_modules\/zod$/.test(path));
  assert.equal(zodEntries.length, 1);
  assert.equal(zodEntries[0][1].version, '4.6.6');
});
