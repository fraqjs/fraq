import { AppLifecycle, type PreparedApp } from '../src/app/lifecycle';
import type { RunningProcess } from '../src/app/runner';
import type { Config } from '../src/config';
import type { ConfigSourceRegistry } from '../src/config/sources';

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

function createConfig(options: { url?: string; fraqVersion?: string } = {}): Config {
  return {
    configVersion: 1,
    fraqVersion: options.fraqVersion ?? '1.0.0',
    milky: {
      url: options.url ?? 'http://localhost:3000',
      connectEvent: true,
    },
    logging: {
      minLevel: 'info',
    },
    versions: {},
  };
}

test('serializes reloads and installs only when effective dependencies change', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  const rootConfigPath = path.resolve('fraq.yml');
  const versionsPath = path.resolve('versions.yml');
  const firstReferencePath = path.resolve('first.yml');
  const failedReferencePath = path.resolve('missing.yml');
  const secondReferencePath = path.resolve('second.yml');
  const watchedFileSets: Set<string>[] = [];
  let notifyChange = (_changedFiles: ReadonlySet<string>) => {};
  let watcherCloseCount = 0;
  let currentConfig = createConfig();
  let currentReference = firstReferencePath;
  let prepareError: Error | undefined;
  let writeCount = 0;
  let installCount = 0;
  let installResult = 0;
  const spawnedProcesses: Array<RunningProcess & { signals: NodeJS.Signals[] }> = [];

  const createSources = (options: {
    files: Iterable<string>;
    onChange: (files: ReadonlySet<string>) => void;
  }): ConfigSourceRegistry => {
    notifyChange = options.onChange;
    watchedFileSets.push(new Set(options.files));
    return {
      update(files) {
        watchedFileSets.push(new Set(files));
      },
      async close() {
        watcherCloseCount += 1;
      },
    };
  };

  const lifecycle = AppLifecycle.create({
    initialFiles: (function* () {
      yield rootConfigPath;
      yield versionsPath;
    })(),
    async prepare(accessedFiles): Promise<PreparedApp> {
      accessedFiles.add(rootConfigPath);
      accessedFiles.add(currentReference);
      if (prepareError) {
        throw prepareError;
      }
      return {
        config: currentConfig,
        packageManager: {
          name: 'pnpm',
          installed: true,
          commandPath: '/test/pnpm',
          allCommandPaths: ['/test/pnpm'],
        },
      };
    },
    dependencies: {
      createSources,
      async install() {
        installCount += 1;
        return installResult;
      },
      spawn() {
        let resolveExit!: (exitCode: number) => void;
        const signals: NodeJS.Signals[] = [];
        const appProcess: RunningProcess & { signals: NodeJS.Signals[] } = {
          exit: new Promise((resolve) => {
            resolveExit = resolve;
          }),
          signals,
          kill(signal) {
            signals.push(signal);
            resolveExit(0);
            return true;
          },
        };
        spawnedProcesses.push(appProcess);
        return appProcess;
      },
      writeFiles() {
        writeCount += 1;
      },
    },
  });

  assert.deepEqual(watchedFileSets[0], new Set([rootConfigPath, versionsPath]));
  await lifecycle.start();
  assert.equal(writeCount, 1);
  assert.equal(installCount, 1);
  assert.equal(spawnedProcesses.length, 1);
  assert.deepEqual(watchedFileSets.at(-1), new Set([rootConfigPath, versionsPath, firstReferencePath]));

  await lifecycle.reconcile();
  assert.equal(writeCount, 1);
  assert.equal(installCount, 1);
  assert.equal(spawnedProcesses.length, 1);

  currentConfig = createConfig({ url: 'http://localhost:4000' });
  await lifecycle.reconcile();
  assert.equal(writeCount, 2);
  assert.equal(installCount, 1);
  assert.equal(spawnedProcesses.length, 2);
  assert.deepEqual(spawnedProcesses[0]?.signals, ['SIGTERM']);

  prepareError = new Error('invalid referenced config');
  currentReference = failedReferencePath;
  await lifecycle.reconcile();
  assert.equal(spawnedProcesses.length, 2);
  assert.deepEqual(
    watchedFileSets.at(-1),
    new Set([rootConfigPath, versionsPath, firstReferencePath, failedReferencePath]),
  );

  prepareError = undefined;
  currentReference = secondReferencePath;
  currentConfig = createConfig({ url: 'http://localhost:5000', fraqVersion: '2.0.0' });
  installResult = 1;
  await lifecycle.reconcile();
  assert.equal(writeCount, 3);
  assert.equal(installCount, 2);
  assert.equal(spawnedProcesses.length, 2);

  currentConfig = createConfig({ url: 'http://localhost:5000' });
  installResult = 0;
  notifyChange(new Set([rootConfigPath]));
  await lifecycle.reconcile();
  assert.equal(writeCount, 4);
  assert.equal(installCount, 3);
  assert.equal(spawnedProcesses.length, 3);
  assert.deepEqual(watchedFileSets.at(-1), new Set([rootConfigPath, versionsPath, secondReferencePath]));

  await lifecycle.shutdown();
  assert.equal(watcherCloseCount, 1);
  assert.deepEqual(spawnedProcesses[2]?.signals, ['SIGTERM']);
});

test('refreshes dependencies and restarts when a runtime entry point changes', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  const rootConfigPath = path.resolve('fraq.yml');
  const entryPointPath = path.resolve('plugin/dist/index.mjs');
  let notifyChange = (_changedFiles: ReadonlySet<string>) => {};
  let installCount = 0;
  const spawnedProcesses: Array<RunningProcess & { signals: NodeJS.Signals[] }> = [];

  const lifecycle = AppLifecycle.create({
    initialFiles: [rootConfigPath],
    async prepare(accessedFiles): Promise<PreparedApp> {
      accessedFiles.add(rootConfigPath);
      accessedFiles.add(entryPointPath);
      return {
        config: createConfig(),
        packageManager: {
          name: 'pnpm',
          installed: true,
          commandPath: '/test/pnpm',
          allCommandPaths: ['/test/pnpm'],
        },
        restartFiles: [entryPointPath],
      };
    },
    dependencies: {
      createSources(options) {
        notifyChange = options.onChange;
        return {
          update() {},
          async close() {},
        };
      },
      async install() {
        installCount += 1;
        return 0;
      },
      spawn() {
        let resolveExit!: (exitCode: number) => void;
        const signals: NodeJS.Signals[] = [];
        const appProcess: RunningProcess & { signals: NodeJS.Signals[] } = {
          exit: new Promise((resolve) => {
            resolveExit = resolve;
          }),
          signals,
          kill(signal) {
            signals.push(signal);
            resolveExit(0);
            return true;
          },
        };
        spawnedProcesses.push(appProcess);
        return appProcess;
      },
      writeFiles() {},
    },
  });

  await lifecycle.start();
  assert.equal(installCount, 1);
  assert.equal(spawnedProcesses.length, 1);

  notifyChange(new Set([rootConfigPath]));
  await lifecycle.reconcile();
  assert.equal(spawnedProcesses.length, 1);

  notifyChange(new Set([entryPointPath]));
  await lifecycle.reconcile();
  assert.equal(installCount, 2);
  assert.equal(spawnedProcesses.length, 2);
  assert.deepEqual(spawnedProcesses[0]?.signals, ['SIGTERM']);

  await lifecycle.shutdown();
});

test('shuts down once and escalates a repeated signal to SIGKILL', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  let closeCount = 0;
  const signals: NodeJS.Signals[] = [];
  let resolveExit!: (exitCode: number) => void;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const lifecycle = AppLifecycle.create({
    initialFiles: [path.resolve('fraq.yml')],
    async prepare(): Promise<PreparedApp> {
      return {
        config: createConfig(),
        packageManager: {
          name: 'pnpm',
          installed: true,
          commandPath: '/test/pnpm',
          allCommandPaths: ['/test/pnpm'],
        },
      };
    },
    dependencies: {
      createSources() {
        return {
          update() {},
          async close() {
            closeCount += 1;
          },
        };
      },
      async install() {
        return 0;
      },
      spawn() {
        return {
          exit,
          kill(signal) {
            signals.push(signal);
            if (signal === 'SIGKILL') {
              resolveExit(137);
            }
            return true;
          },
        };
      },
      writeFiles() {},
    },
  });

  await lifecycle.start();
  const gracefulShutdown = lifecycle.shutdown('SIGTERM');
  assert.deepEqual(signals, ['SIGTERM']);

  const forcedShutdown = lifecycle.shutdown('SIGKILL');
  await Promise.all([gracefulShutdown, forcedShutdown]);

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(closeCount, 1);
});

test('does not prepare the application when shutdown races with initial startup', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  let prepareCount = 0;
  let closeCount = 0;
  let spawnCount = 0;
  const lifecycle = AppLifecycle.create({
    initialFiles: [path.resolve('fraq.yml')],
    async prepare(): Promise<PreparedApp> {
      prepareCount += 1;
      return {
        config: createConfig(),
        packageManager: {
          name: 'pnpm',
          installed: true,
          commandPath: '/test/pnpm',
          allCommandPaths: ['/test/pnpm'],
        },
      };
    },
    dependencies: {
      createSources() {
        return {
          update() {},
          async close() {
            closeCount += 1;
          },
        };
      },
      async install() {
        return 0;
      },
      spawn() {
        spawnCount += 1;
        return {
          exit: Promise.resolve(0),
          kill() {
            return true;
          },
        };
      },
      writeFiles() {},
    },
  });

  const startup = lifecycle.start();
  const shutdown = lifecycle.shutdown();
  await Promise.all([startup, shutdown]);

  assert.equal(prepareCount, 0);
  assert.equal(spawnCount, 0);
  assert.equal(closeCount, 1);
});
