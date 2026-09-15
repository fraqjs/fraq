import { ProcessRegistry } from '../src/app/processes';

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
    const exitCode = await new ProcessRegistry().install({
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
    assert.equal(await new ProcessRegistry().run(), 7);
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test('recognizes only the versioned readiness message and preserves later exit codes', async () => {
  const { spawnAppProcess } = await import('../src/app/processes');
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
  const { spawnAppProcess } = await import('../src/app/processes');
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

test('tees real child output into the bounded log cache while serving control IPC', async () => {
  const { spawnAppProcess } = await import('../src/app/processes');
  const { LogRegistry } = await import('../src/app/logs');
  const originalCwd = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'fraq-control-runner-'));
  const script = path.join(root, 'child.cjs');
  await mkdir(path.join(root, 'app'));
  await writeFile(
    script,
    `
    console.log('app output');
    process.send({ type: 'fraq:control:request', version: 1, id: 'hello', method: 'hello' });
    process.on('message', (message) => {
      if (message.type !== 'fraq:control:response') return;
      console.log('protocol ' + message.result.version);
      process.send({ type: 'fraq:ready', version: 1 });
      process.stderr.write('unterminated error');
      setTimeout(() => process.exit(0), 10);
    });
  `,
  );
  try {
    process.chdir(root);
    const logs = new LogRegistry();
    const child = spawnAppProcess(script, 1000, {
      logs,
      onRequest: async (request) => ({
        type: 'fraq:control:response',
        version: 1,
        id: request.id,
        result: { version: 1 },
      }),
    });
    await child.ready;
    assert.equal(await child.exit, 0);
    assert.deepEqual(
      logs
        .read()
        .entries.filter((line) => line.stream === 'stdout')
        .map((line) => line.text),
      ['app output', 'protocol 1'],
    );
    assert.equal(logs.read().entries.find((line) => line.stream === 'stderr')?.text, 'unterminated error');
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test('terminates installation and application processes together and refuses new work during shutdown', async () => {
  const createChild = () => {
    let finish!: (code: number) => void;
    const signals: NodeJS.Signals[] = [];
    return {
      exit: new Promise<number>((resolve) => {
        finish = resolve;
      }),
      ready: Promise.resolve(),
      signals,
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        if (signal === 'SIGKILL') finish(137);
        return true;
      },
    };
  };
  const app = createChild();
  const install = createChild();
  let unexpectedExits = 0;
  const processes = new ProcessRegistry({ spawn: () => app, install: () => install }, undefined, undefined, () => {
    unexpectedExits++;
  });
  await processes.launch('/test/index.mjs');
  const installing = processes.install({ name: 'npm', installed: true, commandPath: '/test/npm', allCommandPaths: [] });
  processes.shutdown('SIGTERM');
  const closing = processes.close();
  assert.deepEqual(app.signals, ['SIGTERM']);
  assert.deepEqual(install.signals, ['SIGTERM']);
  await assert.rejects(processes.launch('/test/other.mjs'), /stopping/);
  processes.shutdown('SIGKILL');
  processes.shutdown('SIGKILL');
  await closing;
  assert.equal(await installing, 137);
  assert.deepEqual(app.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(install.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(unexpectedExits, 0);
  assert.equal(processes.running, false);
});
