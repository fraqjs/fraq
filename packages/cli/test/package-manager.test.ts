import { detectPackageManager, type PackageManagerName } from '../src/package-manager';

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function writePackageManagerShim(
  directory: string,
  name: PackageManagerName,
  behavior: 'fail' | 'hang' | string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const commandPath = path.join(directory, `${name}${process.platform === 'win32' ? '.cmd' : ''}`);
  const contents =
    process.platform === 'win32'
      ? behavior === 'fail'
        ? '@echo off\r\nexit /b 1\r\n'
        : behavior === 'hang'
          ? '@echo off\r\n"%SystemRoot%\\System32\\ping.exe" 127.0.0.1 -n 30 >nul\r\n'
          : `@echo off\r\necho ${behavior}\r\n`
      : behavior === 'fail'
        ? '#!/bin/sh\nexit 1\n'
        : behavior === 'hang'
          ? '#!/bin/sh\n/bin/sleep 30\n'
          : `#!/bin/sh\nprintf '${behavior}\\n'\n`;

  await writeFile(commandPath, contents);
  if (process.platform !== 'win32') {
    await chmod(commandPath, 0o755);
  }
  return commandPath;
}

async function withPath<T>(directories: string[], callback: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  process.env.PATH = directories.join(path.delimiter);
  if (process.platform === 'win32') {
    process.env.PATHEXT = '.CMD';
  }

  try {
    return await callback();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathExt;
    }
  }
}

test('detects a package manager whose command path contains spaces', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fraq package manager '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binPath = path.join(root, 'bin with spaces');
  const commandPath = await writePackageManagerShim(binPath, 'npm', '10.9.2');

  const result = await withPath([binPath], () => detectPackageManager('npm'));

  assert.equal(result.installed, true);
  assert.equal(result.commandPath, commandPath);
  assert.equal(result.version, '10.9.2');
});

test('uses the next PATH candidate when the first shim is broken', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fraq-package-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const brokenCommand = await writePackageManagerShim(path.join(root, 'broken'), 'pnpm', 'fail');
  const workingCommand = await writePackageManagerShim(path.join(root, 'working'), 'pnpm', '9.15.0');

  const result = await withPath([path.dirname(brokenCommand), path.dirname(workingCommand)], () =>
    detectPackageManager('pnpm'),
  );

  assert.equal(result.installed, true);
  assert.equal(result.commandPath, workingCommand);
  assert.equal(result.version, '9.15.0');
  assert.deepEqual(result.allCommandPaths, [brokenCommand, workingCommand]);
});

test('times out a stuck shim and continues to the next PATH candidate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fraq-package-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stuckCommand = await writePackageManagerShim(path.join(root, 'stuck'), 'yarn', 'hang');
  const workingCommand = await writePackageManagerShim(path.join(root, 'working'), 'yarn', '1.22.22');

  const result = await withPath([path.dirname(stuckCommand), path.dirname(workingCommand)], () =>
    detectPackageManager('yarn'),
  );

  assert.equal(result.installed, true);
  assert.equal(result.commandPath, workingCommand);
  assert.equal(result.version, '1.22.22');
});
