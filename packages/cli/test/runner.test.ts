import { installAppDependencies, startAppProcess } from '../src/app/runner';

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('installs with a package manager path containing spaces and preserves argument boundaries', async () => {
  const originalCwd = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'fraq process '));
  const binPath = path.join(root, 'bin with spaces');
  const commandPath = path.join(binPath, `npm${process.platform === 'win32' ? '.cmd' : ''}`);
  const argumentsPath = path.join(root, 'arguments.json');
  const recorderPath = path.join(root, 'record-arguments.cjs');
  await mkdir(path.join(root, 'app'), { recursive: true });
  await mkdir(binPath, { recursive: true });
  await writeFile(
    recorderPath,
    `require('node:fs').writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  await writeFile(
    commandPath,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${recorderPath}" %*\r\n`
      : `#!/bin/sh\n'${process.execPath}' '${recorderPath}' "$@"\n`,
  );
  if (process.platform !== 'win32') {
    await chmod(commandPath, 0o755);
  }

  try {
    process.chdir(root);
    const exitCode = await installAppDependencies({
      name: 'npm',
      installed: true,
      commandPath,
      allCommandPaths: [commandPath],
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(argumentsPath, 'utf8')), ['install', '--legacy-peer-deps']);
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test('returns the generated application exit code', async () => {
  const originalCwd = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'fraq-process-'));
  await mkdir(path.join(root, 'app'), { recursive: true });
  await writeFile(path.join(root, 'app', 'index.js'), 'process.exitCode = 7;\n');

  try {
    process.chdir(root);
    assert.equal(await startAppProcess(), 7);
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test('recognizes only the versioned readiness message and preserves later exit codes', async () => {
  const { spawnAppProcess } = await import('../src/app/runner');
  const root = await mkdtemp(path.join(os.tmpdir(), 'fraq-ready-'));
  const script = path.join(root, 'ready.cjs');
  await writeFile(
    script,
    `
    process.send({ type: 'fraq:ready', version: 0 });
    setTimeout(() => process.send({ type: 'fraq:ready', version: 1 }), 30);
    setTimeout(() => process.exit(9), 60);
  `,
  );
  const originalCwd = process.cwd();
  await mkdir(path.join(root, 'app'));
  try {
    process.chdir(root);
    const child = spawnAppProcess(script);
    await child.ready;
    assert.equal(await child.exit, 9);
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects readiness on early exit and times out a hung startup', async () => {
  const { spawnAppProcess } = await import('../src/app/runner');
  const root = await mkdtemp(path.join(os.tmpdir(), 'fraq-unready-'));
  const script = path.join(root, 'startup.cjs');
  const originalCwd = process.cwd();
  await mkdir(path.join(root, 'app'));
  try {
    process.chdir(root);
    await writeFile(script, 'process.exit(3);');
    const failed = spawnAppProcess(script);
    await assert.rejects(failed.ready, /before becoming ready/);
    assert.equal(await failed.exit, 3);

    await writeFile(script, 'setInterval(() => {}, 1000);');
    const hung = spawnAppProcess(script, 100);
    try {
      await assert.rejects(hung.ready, /within 100ms/);
    } finally {
      hung.kill('SIGKILL');
      await hung.exit;
    }
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});
