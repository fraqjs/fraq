import { AppLifecycle, type AppLifecycleOptions } from '../src/app';
import type { RunningAppProcess } from '../src/app/processes';
import { dependencyFingerprint, type Runtime, type RuntimeOptions, type RuntimeStore } from '../src/app/runtimes';
import { buildStartScript } from '../src/app/start-script';
import type { Config } from '../src/config';

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

function createConfig(url = 'http://localhost:3000'): Config {
  return {
    configVersion: 1,
    fraqVersion: '1.0.0',
    milky: { url, connectEvent: true },
    logging: { minLevel: 'info' },
    versions: {},
  };
}

const packageManager = {
  name: 'pnpm' as const,
  installed: true,
  commandPath: '/test/pnpm',
  allCommandPaths: ['/test/pnpm'],
};
const configPath = path.resolve('fraq.yml');
const entryPoint = path.resolve('plugin/dist/index.mjs');

function runtime(config = createConfig()): Runtime {
  return {
    directory: '/test/runtime',
    entryPoint: `/test/runtime/${new URL(config.milky.url).port}.mjs`,
    startScript: buildStartScript(config),
    fingerprint: dependencyFingerprint(config, packageManager),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness(t: TestContext) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const state = {
    config: createConfig(),
    prepareError: undefined as Error | undefined,
    stageError: undefined as Error | undefined,
    reference: path.resolve('reference.yml'),
    staged: [] as RuntimeOptions[],
    watched: [] as Set<string>[],
    beforeStage: undefined as (() => Promise<void>) | undefined,
    ready: (() => Promise.resolve()) as () => Promise<void>,
    killExits: true,
    prepareCount: 0,
    closeCount: 0,
  };
  let notifyChange = (_files: ReadonlySet<string>) => {};
  const processes: Array<RunningAppProcess & { signals: NodeJS.Signals[]; entry: string; finish(code: number): void }> =
    [];
  const store: RuntimeStore = {
    async prepare(config, _pm, options) {
      state.staged.push(options);
      await state.beforeStage?.();
      if (state.stageError) {
        throw state.stageError;
      }
      return runtime(config);
    },
    close() {},
  };
  const lifecycleOptions: AppLifecycleOptions = {
    initialFiles: [configPath],
    async prepare(accessedFiles) {
      state.prepareCount++;
      accessedFiles.add(state.reference);
      if (state.prepareError) {
        throw state.prepareError;
      }
      return { config: state.config, packageManager, restartFiles: [entryPoint] };
    },
    dependencies: {
      createSources(options) {
        notifyChange = options.onChange;
        return {
          update(files) {
            state.watched.push(new Set(files));
          },
          async close() {
            state.closeCount++;
          },
        };
      },
      createRuntimes: () => store,
      spawn(entry = '') {
        const exit = deferred<number>();
        const stopped = deferred<void>();
        const ready = Promise.race([state.ready(), stopped.promise]);
        const appProcess = {
          exit: exit.promise,
          ready,
          entry,
          signals: [] as NodeJS.Signals[],
          finish: exit.resolve,
          kill(signal: NodeJS.Signals) {
            this.signals.push(signal);
            if (state.killExits || signal === 'SIGKILL') {
              stopped.reject(new Error('Process stopped before readiness'));
              exit.resolve(signal === 'SIGKILL' ? 137 : 0);
            }
            return true;
          },
        };
        processes.push(appProcess);
        return appProcess;
      },
    },
  };
  const lifecycle = AppLifecycle.create(lifecycleOptions);
  t.after(() => lifecycle.shutdown('SIGKILL'));
  return { state, processes, lifecycle, notify: (files: string[]) => notifyChange(new Set(files)) };
}

test('keeps the current process on validation or installation failure and watches failed references', async (t) => {
  const { state, processes, lifecycle } = harness(t);
  await lifecycle.start();
  await lifecycle.reconcile();
  assert.equal(state.staged.length, 1);

  state.prepareError = new Error('invalid referenced config');
  state.reference = path.resolve('missing.yml');
  await lifecycle.reconcile();
  assert.equal(processes.length, 1);
  assert.deepEqual(processes[0]?.signals, []);
  assert.ok(state.watched.at(-1)?.has(state.reference));
  assert.ok(state.watched.at(-1)?.has(path.resolve('reference.yml')));

  state.prepareError = undefined;
  state.config = createConfig('http://localhost:4000');
  state.stageError = new Error('package manager install failed');
  await lifecycle.reconcile();
  assert.deepEqual(processes[0]?.signals, []);

  state.stageError = undefined;
  await lifecycle.reconcile();
  assert.equal(processes.length, 2);
  assert.deepEqual(processes[0]?.signals, ['SIGTERM']);
});

test('remembers only ready runtimes and rolls back a failed candidate once', async (t) => {
  const { state, processes, lifecycle } = harness(t);
  await lifecycle.start();
  const successful = runtime();
  state.config = createConfig('http://localhost:4000');
  const candidateReady = deferred<void>();
  const candidateSpawned = deferred<void>();
  let attempts = 0;
  state.ready = () => {
    if (attempts++ === 0) {
      candidateSpawned.resolve();
      return candidateReady.promise;
    }
    return Promise.resolve();
  };
  const reload = lifecycle.reconcile();
  await candidateSpawned.promise;
  assert.equal(lifecycle.status().state, 'restarting');
  candidateReady.reject(new Error('plugin failed to start'));
  await reload;
  assert.equal(processes.length, 3);
  assert.equal(processes[2]?.entry, successful?.entryPoint);
  assert.deepEqual(processes[1]?.signals, ['SIGTERM']);
});

test('stops retrying if the session fallback also fails', async (t) => {
  const { state, processes, lifecycle } = harness(t);
  await lifecycle.start();
  state.config = createConfig('http://localhost:4000');
  state.ready = () => Promise.reject(new Error('startup failed'));
  await lifecycle.reconcile();
  assert.equal(processes.length, 3);
  assert.equal(processes[2]?.entry, runtime().entryPoint);
});

for (const phase of ['configuration', 'installation', 'readiness'] as const) {
  test(`first watch startup exits on ${phase} failure and ignores queued repairs`, async (t) => {
    const { state, processes, lifecycle, notify } = harness(t);
    const error = new Error('first startup failed');
    if (phase === 'configuration') state.prepareError = error;
    if (phase === 'installation') state.stageError = error;
    if (phase === 'readiness') state.ready = () => Promise.reject(error);
    await lifecycle.start();
    assert.equal(await lifecycle.waitForExit(), 1);
    assert.equal(processes.length, phase === 'readiness' ? 1 : 0);
    const prepareCount = state.prepareCount;
    state.prepareError = undefined;
    state.stageError = undefined;
    state.ready = () => Promise.resolve();
    notify([configPath]);
    await lifecycle.reconcile();
    assert.equal(state.prepareCount, prepareCount);
  });
}

test('refreshes a workspace installation on entry changes and serializes newer configurations', async (t) => {
  const { state, processes, lifecycle, notify } = harness(t);
  await lifecycle.start();
  notify([entryPoint]);
  await lifecycle.reconcile();
  assert.equal(state.staged.at(-1)?.refresh, true);
  assert.equal(processes.length, 2);

  const staging = deferred<void>();
  const release = deferred<void>();
  state.beforeStage = () => {
    state.beforeStage = undefined;
    staging.resolve();
    return release.promise;
  };
  state.config = createConfig('http://localhost:4000');
  const reload = lifecycle.reconcile();
  await staging.promise;
  state.config = createConfig('http://localhost:5000');
  notify([configPath]);
  release.resolve();
  await reload;
  assert.equal(processes.length, 3);
  assert.equal(processes[2]?.entry, runtime(state.config).entryPoint);
});

test('shuts down once and escalates a repeated signal to SIGKILL', async (t) => {
  const { state, processes, lifecycle } = harness(t);
  state.killExits = false;
  await lifecycle.start();
  const graceful = lifecycle.shutdown('SIGTERM');
  assert.deepEqual(processes[0]?.signals, ['SIGTERM']);
  await Promise.all([graceful, lifecycle.shutdown('SIGKILL')]);
  assert.deepEqual(processes[0]?.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(state.closeCount, 1);
});

test('shutdown during readiness does not roll back', async (t) => {
  const { state, processes, lifecycle } = harness(t);
  const spawned = deferred<void>();
  state.ready = () => {
    spawned.resolve();
    return new Promise(() => {});
  };
  const startup = lifecycle.start();
  await spawned.promise;
  await Promise.all([startup, lifecycle.shutdown()]);
  assert.equal(processes.length, 1);
});

test('does not prepare when shutdown races with initial startup', async (t) => {
  const { state, processes, lifecycle } = harness(t);
  await Promise.all([lifecycle.start(), lifecycle.shutdown()]);
  assert.equal(state.prepareCount, 0);
  assert.equal(processes.length, 0);
  assert.equal(state.closeCount, 1);
});

test('watch does not roll back an application that exits after readiness', async (t) => {
  const { processes, lifecycle } = harness(t);
  await lifecycle.start();
  processes[0]?.finish(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(processes.length, 1);
});

test('workspace changes received during readiness trigger another refresh', async (t) => {
  const { state, processes, lifecycle, notify } = harness(t);
  await lifecycle.start();
  const spawned = deferred<void>();
  const ready = deferred<void>();
  state.ready = () => {
    state.ready = () => Promise.resolve();
    spawned.resolve();
    return ready.promise;
  };
  notify([entryPoint]);
  const reload = lifecycle.reconcile();
  await spawned.promise;
  notify([entryPoint]);
  ready.resolve();
  await reload;
  assert.equal(processes.length, 3);
  assert.equal(state.staged.at(-1)?.refresh, true);
});

test('rolls back to the latest successful reload within the same session', async (t) => {
  const { state, processes, lifecycle } = harness(t);
  await lifecycle.start();
  state.config = createConfig('http://localhost:4000');
  await lifecycle.reconcile();
  const successful = runtime(state.config);
  state.config = createConfig('http://localhost:5000');
  state.ready = () => {
    state.ready = () => Promise.resolve();
    return Promise.reject(new Error('candidate failed'));
  };
  await lifecycle.reconcile();
  assert.equal(processes.length, 4);
  assert.equal(processes[3]?.entry, successful.entryPoint);
});

test('coalesces explicit restarts and watcher changes and reports fallback status', async (t) => {
  const { state, processes, lifecycle, notify } = harness(t);
  await lifecycle.start();
  assert.equal(lifecycle.status().generation, 1);
  lifecycle.restart();
  lifecycle.restart();
  state.config = createConfig('http://localhost:4000');
  notify([configPath]);
  await lifecycle.reconcile();
  assert.equal(processes.length, 2);
  assert.equal(lifecycle.status().generation, 2);
  assert.equal(lifecycle.status().busy, false);
  lifecycle.restart();
  await lifecycle.reconcile();
  assert.equal(processes.length, 3);
  assert.equal(state.staged.at(-1)?.refresh, false);
  state.prepareError = new Error('invalid config');
  await lifecycle.reconcile();
  assert.equal(lifecycle.status().fallback, true);
  assert.equal(lifecycle.status().error, 'invalid config');
  assert.equal(lifecycle.status().state, 'running');
});

test('keeps stopped status when a ready application exits before promotion completes', async (t) => {
  const { state, processes, lifecycle } = harness(t);
  state.ready = () => {
    queueMicrotask(() => processes.at(-1)?.finish(0));
    return Promise.resolve();
  };
  await lifecycle.start();
  assert.equal(lifecycle.status().generation, 1);
  assert.equal(lifecycle.status().state, 'stopped');
});

test('closes control before waiting for shutdown and releases runtimes only after process exit', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  let request: NonNullable<Parameters<typeof import('../src/app/processes').spawnAppProcess>[2]>['onRequest'];
  let finish!: (code: number) => void;
  let processExited = false;
  let runtimeClosed = false;
  const exit = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const session = AppLifecycle.create({
    initialFiles: [configPath],
    prepare: async () => ({ config: createConfig(), packageManager }),
    dependencies: {
      createSources: () => ({ update() {}, async close() {} }),
      createRuntimes: () => ({
        prepare: async () => runtime(),
        close() {
          assert.equal(processExited, true);
          runtimeClosed = true;
        },
      }),
      spawn(_entry, _timeout, options) {
        request = options?.onRequest;
        return {
          exit,
          ready: Promise.resolve(),
          kill() {
            return true;
          },
        };
      },
    },
  });
  const initialListeners = process.listenerCount('SIGTERM');
  await session.start();
  assert.equal(process.listenerCount('SIGTERM'), initialListeners + 1);
  const shutdown = session.shutdown();
  assert.ok(request);
  assert.equal(
    (await request({ type: 'fraq:control:request', version: 1, id: 'status', method: 'status', input: undefined }))
      .error?.code,
    'unavailable',
  );
  assert.equal(runtimeClosed, false);
  assert.equal(process.listenerCount('SIGTERM'), initialListeners + 1);
  processExited = true;
  finish(0);
  await shutdown;
  assert.equal(runtimeClosed, true);
  assert.equal(process.listenerCount('SIGTERM'), initialListeners);
});

test('kernel shutdown cancels an ongoing install before any application is spawned', async (t) => {
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const root = mkdtempSync(path.join(tmpdir(), 'fraq-install-shutdown-'));
  const cwd = process.cwd();
  process.chdir(root);
  const installing = deferred<void>();
  const exited = deferred<number>();
  const signals: NodeJS.Signals[] = [];
  let spawned = false;
  const session = AppLifecycle.create({
    initialFiles: [],
    prepare: async () => ({ config: createConfig(), packageManager }),
    dependencies: {
      createSources: () => ({ update() {}, async close() {} }),
      install() {
        installing.resolve();
        return {
          exit: exited.promise,
          kill(signal) {
            signals.push(signal);
            exited.resolve(143);
            return true;
          },
        };
      },
      spawn() {
        spawned = true;
        throw new Error('Must not spawn during shutdown.');
      },
    },
  });
  try {
    const startup = session.start();
    await installing.promise;
    await Promise.all([startup, session.shutdown()]);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(spawned, false);
    assert.deepEqual(readdirSync(path.join(root, 'app', 'runtimes')), []);
  } finally {
    await session.shutdown('SIGKILL');
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
