import chalk from 'chalk';

import type { Config } from '../config';
import { createConfigSourceRegistry } from '../config/sources';
import type { PackageManagerInfo } from '../package-manager';
import { writeAppFiles } from './files';
import { generateAppPackageJson } from './package-json';
import { installAppDependencies, type RunningProcess, spawnAppProcess } from './runner';
import { buildStartScript } from './start-script';

import { constants as osConstants } from 'node:os';
import path from 'node:path';

const terminationSignals: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

export interface PreparedApp {
  config: Config;
  packageManager: PackageManagerInfo & { commandPath: string };
  restartFiles?: Iterable<string>;
}

export interface WatchAppOptions {
  initialFiles: Iterable<string>;
  prepare: (accessedFiles: Set<string>) => Promise<PreparedApp>;
}

export interface AppLifecycle {
  reconcile(): Promise<void>;
  shutdown(signal?: NodeJS.Signals): Promise<void>;
}

interface LifecycleDependencies {
  createSources: typeof createConfigSourceRegistry;
  install: typeof installAppDependencies;
  spawn: typeof spawnAppProcess;
  writeFiles: typeof writeAppFiles;
}

function dependencyFingerprint(config: Config, packageManager: PackageManagerInfo): string {
  const dependencies = Object.entries(generateAppPackageJson(config).dependencies).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify({ packageManager: packageManager.name, dependencies });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAppLifecycle(
  options: WatchAppOptions,
  overrides: Partial<LifecycleDependencies> = {},
): AppLifecycle {
  const dependencies: LifecycleDependencies = {
    createSources: createConfigSourceRegistry,
    install: installAppDependencies,
    spawn: spawnAppProcess,
    writeFiles: writeAppFiles,
    ...overrides,
  };
  const initialFiles = new Set(options.initialFiles);
  let watchedFiles = new Set(initialFiles);
  let currentProcess: RunningProcess | undefined;
  let expectedExit: RunningProcess | undefined;
  let activeStop: { process: RunningProcess; promise: Promise<void> } | undefined;
  let installedDependencies: string | undefined;
  let installationInvalid = false;
  let appliedStartScript: string | undefined;
  let restartFiles = new Set<string>();
  let applicationInvalid = false;
  let dirty = false;
  let closing = false;
  let activeReconcile: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const sources = dependencies.createSources({
    files: watchedFiles,
    onChange: (changedFiles) => {
      if ([...changedFiles].some((file) => restartFiles.has(path.resolve(file)))) {
        applicationInvalid = true;
        installationInvalid = true;
      }
      void requestReconcile();
    },
    onError: (error) => {
      console.error(chalk.red(`Configuration watcher failed: ${describeError(error)}`));
    },
  });

  function updateSources(accessedFiles: Set<string>, successful: boolean): void {
    watchedFiles = successful
      ? new Set([...initialFiles, ...accessedFiles])
      : new Set([...watchedFiles, ...accessedFiles]);
    sources.update(watchedFiles);
  }

  async function stopCurrentProcess(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const appProcess = currentProcess;
    if (!appProcess) {
      return;
    }
    if (activeStop?.process === appProcess) {
      if (signal === 'SIGKILL') {
        appProcess.kill(signal);
      }
      return activeStop.promise;
    }
    expectedExit = appProcess;
    appProcess.kill(signal);
    const stopPromise = appProcess.exit.then(() => {
      if (currentProcess === appProcess) {
        currentProcess = undefined;
      }
      if (expectedExit === appProcess) {
        expectedExit = undefined;
      }
      if (activeStop?.process === appProcess) {
        activeStop = undefined;
      }
    });
    activeStop = { process: appProcess, promise: stopPromise };
    return stopPromise;
  }

  async function runReconcileLoop(): Promise<void> {
    while (dirty && !closing) {
      dirty = false;
      const accessedFiles = new Set<string>();

      try {
        const prepared = await options.prepare(accessedFiles);
        updateSources(accessedFiles, true);
        restartFiles = new Set(Array.from(prepared.restartFiles ?? [], (file) => path.resolve(file)));
        if (dirty) {
          continue;
        }

        const nextStartScript = buildStartScript(prepared.config);
        const nextDependencies = dependencyFingerprint(prepared.config, prepared.packageManager);
        const dependenciesChanged = installationInvalid || nextDependencies !== installedDependencies;
        const applicationChanged = applicationInvalid || nextStartScript !== appliedStartScript;

        if (currentProcess && !dependenciesChanged && !applicationChanged) {
          continue;
        }

        const restarting = currentProcess !== undefined;
        if (restarting) {
          console.log(chalk.magenta('Changes detected. Stopping the current process...'));
        }
        await stopCurrentProcess();
        if (closing) {
          break;
        }

        dependencies.writeFiles(prepared.config);
        if (dependenciesChanged) {
          installationInvalid = true;
          if (restarting) {
            console.log();
          }
          console.log(
            chalk.cyan(
              `Installing application dependencies with ${chalk.bold(chalk.magenta(prepared.packageManager.name))}...`,
            ),
          );
          const installResult = await dependencies.install(prepared.packageManager);
          if (installResult !== 0) {
            throw new Error(`Package manager install failed with exit code ${installResult}.`);
          }
          installedDependencies = nextDependencies;
          console.log();
        }

        if (closing || dirty) {
          continue;
        }
        installationInvalid = false;
        if (restarting) {
          console.log();
          console.log(chalk.cyan('Restarting the Fraq application...'));
        } else {
          console.log(chalk.cyan('Starting the Fraq application...'));
        }
        const appProcess = dependencies.spawn();
        currentProcess = appProcess;
        appliedStartScript = nextStartScript;
        applicationInvalid = false;
        void appProcess.exit.then((exitCode) => {
          if (currentProcess !== appProcess) {
            return;
          }
          currentProcess = undefined;
          if (!closing && expectedExit !== appProcess) {
            console.error(
              chalk.red(`Fraq application exited with code ${exitCode}; waiting for a configuration change.`),
            );
          }
        });
      } catch (error) {
        updateSources(accessedFiles, false);
        if (!closing) {
          console.error(chalk.red(`Failed to reload the Fraq application:\n${describeError(error)}`));
        }
      }
    }
  }

  function requestReconcile(): Promise<void> {
    if (closing) {
      return activeReconcile ?? Promise.resolve();
    }
    dirty = true;
    activeReconcile ??= runReconcileLoop().finally(() => {
      activeReconcile = undefined;
      if (dirty && !closing) {
        void requestReconcile();
      }
    });
    return activeReconcile;
  }

  function shutdown(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    closing = true;
    if (shutdownPromise) {
      if (signal === 'SIGKILL') {
        currentProcess?.kill(signal);
      }
      return shutdownPromise;
    }
    const stopPromise = stopCurrentProcess(signal);
    shutdownPromise ??= (async () => {
      await sources.close();
      await activeReconcile;
      await stopPromise;
    })();
    return shutdownPromise;
  }

  return {
    reconcile: requestReconcile,
    shutdown,
  };
}

export async function startWatchedApp(options: WatchAppOptions): Promise<number> {
  const lifecycle = createAppLifecycle(options);
  let receivedSignal: NodeJS.Signals | undefined;
  let resolveSignal!: (signal: NodeJS.Signals) => void;
  const signalReceived = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of terminationSignals) {
    const handler = () => {
      if (receivedSignal === undefined) {
        receivedSignal = signal;
        resolveSignal(signal);
        void lifecycle.shutdown(signal);
      } else {
        void lifecycle.shutdown('SIGKILL');
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    await lifecycle.reconcile();
    const signal = await signalReceived;
    await lifecycle.shutdown(signal);
    return 128 + (osConstants.signals[signal] ?? 1);
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  }
}
