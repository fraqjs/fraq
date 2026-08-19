import { type ContextState, defineContext } from '@fraqjs/kernel';
import chalk from 'chalk';

import type { Config } from '../config';
import { type ConfigSourceRegistry, createConfigSourceRegistry } from '../config/sources';
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

interface LifecycleDependencies {
  createSources: typeof createConfigSourceRegistry;
  install: typeof installAppDependencies;
  spawn: typeof spawnAppProcess;
  writeFiles: typeof writeAppFiles;
}

export interface AppLifecycleOptions extends WatchAppOptions {
  dependencies?: Partial<LifecycleDependencies>;
}

interface AppLifecycleSystems {
  application: ApplicationManager;
  sources: ConfigSourceRegistry;
}

interface AppLifecycleBuiltins {
  reconcile(): Promise<void>;
  shutdown(signal?: NodeJS.Signals): Promise<void>;
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

class ApplicationManager {
  private readonly initialFiles: Set<string>;
  private watchedFiles: Set<string>;
  private sources?: ConfigSourceRegistry;
  private currentProcess?: RunningProcess;
  private expectedExit?: RunningProcess;
  private activeStop?: { process: RunningProcess; promise: Promise<void> };
  private installedDependencies?: string;
  private installationInvalid = false;
  private appliedStartScript?: string;
  private restartFiles = new Set<string>();
  private applicationInvalid = false;
  private dirty = false;
  private activeReconcile?: Promise<void>;
  private stopSignal?: NodeJS.Signals;
  private suspendedProcess?: Promise<void>;
  private stopContext?: () => Promise<void>;

  constructor(
    private readonly options: WatchAppOptions,
    private readonly dependencies: LifecycleDependencies,
    private readonly getState: () => ContextState,
  ) {
    this.initialFiles = new Set(options.initialFiles);
    this.watchedFiles = new Set(this.initialFiles);
  }

  attachSources(sources: ConfigSourceRegistry): void {
    this.sources = sources;
  }

  bindStop(stopContext: () => Promise<void>): void {
    this.stopContext = stopContext;
  }

  filesChanged(changedFiles: ReadonlySet<string>): void {
    if ([...changedFiles].some((file) => this.restartFiles.has(path.resolve(file)))) {
      this.applicationInvalid = true;
      this.installationInvalid = true;
    }
    void this.reconcile();
  }

  reconcile(): Promise<void> {
    const state = this.getState();
    if (this.stopSignal !== undefined || state === 'stopping' || state === 'stopped') {
      return this.activeReconcile ?? Promise.resolve();
    }
    this.dirty = true;
    if (state !== 'started') {
      return this.activeReconcile ?? Promise.resolve();
    }
    this.activeReconcile ??= this.runReconcileLoop().finally(() => {
      this.activeReconcile = undefined;
      if (this.dirty && this.getState() === 'started') {
        void this.reconcile();
      }
    });
    return this.activeReconcile;
  }

  shutdown(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    this.stopSignal = signal;
    if (signal === 'SIGKILL' && this.getState() === 'stopping') {
      this.currentProcess?.kill(signal);
    }
    if (!this.stopContext) {
      return Promise.reject(new Error('App lifecycle has not been wired.'));
    }
    return this.stopContext();
  }

  suspend(): void {
    this.dirty = false;
    this.suspendedProcess = this.stopCurrentProcess(this.stopSignal ?? 'SIGTERM');
  }

  async deactivate(): Promise<void> {
    await this.activeReconcile;
    await this.suspendedProcess;
  }

  private updateSources(accessedFiles: Set<string>, successful: boolean): void {
    this.watchedFiles = successful
      ? new Set([...this.initialFiles, ...accessedFiles])
      : new Set([...this.watchedFiles, ...accessedFiles]);
    this.sources?.update(this.watchedFiles);
  }

  private async stopCurrentProcess(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const appProcess = this.currentProcess;
    if (!appProcess) {
      return;
    }
    if (this.activeStop?.process === appProcess) {
      if (signal === 'SIGKILL') {
        appProcess.kill(signal);
      }
      return this.activeStop.promise;
    }
    this.expectedExit = appProcess;
    appProcess.kill(signal);
    const stopPromise = appProcess.exit.then(() => {
      if (this.currentProcess === appProcess) {
        this.currentProcess = undefined;
      }
      if (this.expectedExit === appProcess) {
        this.expectedExit = undefined;
      }
      if (this.activeStop?.process === appProcess) {
        this.activeStop = undefined;
      }
    });
    this.activeStop = { process: appProcess, promise: stopPromise };
    return stopPromise;
  }

  private async runReconcileLoop(): Promise<void> {
    while (this.dirty && this.stopSignal === undefined && this.getState() === 'started') {
      this.dirty = false;
      const accessedFiles = new Set<string>();

      try {
        const prepared = await this.options.prepare(accessedFiles);
        this.updateSources(accessedFiles, true);
        this.restartFiles = new Set(Array.from(prepared.restartFiles ?? [], (file) => path.resolve(file)));
        if (this.dirty) {
          continue;
        }

        const nextStartScript = buildStartScript(prepared.config);
        const nextDependencies = dependencyFingerprint(prepared.config, prepared.packageManager);
        const dependenciesChanged = this.installationInvalid || nextDependencies !== this.installedDependencies;
        const applicationChanged = this.applicationInvalid || nextStartScript !== this.appliedStartScript;

        if (this.currentProcess && !dependenciesChanged && !applicationChanged) {
          continue;
        }

        const restarting = this.currentProcess !== undefined;
        if (restarting) {
          console.log(chalk.magenta('Changes detected. Stopping the current process...'));
        }
        await this.stopCurrentProcess();
        if (this.stopSignal !== undefined || this.getState() !== 'started') {
          break;
        }

        this.dependencies.writeFiles(prepared.config);
        if (dependenciesChanged) {
          this.installationInvalid = true;
          if (restarting) {
            console.log();
          }
          console.log(
            chalk.cyan(
              `Installing application dependencies with ${chalk.bold(chalk.magenta(prepared.packageManager.name))}...`,
            ),
          );
          const installResult = await this.dependencies.install(prepared.packageManager);
          if (installResult !== 0) {
            throw new Error(`Package manager install failed with exit code ${installResult}.`);
          }
          this.installedDependencies = nextDependencies;
          console.log();
        }

        if (this.stopSignal !== undefined || this.getState() !== 'started' || this.dirty) {
          continue;
        }
        this.installationInvalid = false;
        if (restarting) {
          console.log();
          console.log(chalk.cyan('Restarting the Fraq application...'));
        } else {
          console.log(chalk.cyan('Starting the Fraq application...'));
        }
        const appProcess = this.dependencies.spawn();
        this.currentProcess = appProcess;
        this.appliedStartScript = nextStartScript;
        this.applicationInvalid = false;
        void appProcess.exit.then((exitCode) => {
          if (this.currentProcess !== appProcess) {
            return;
          }
          this.currentProcess = undefined;
          if (this.getState() === 'started' && this.expectedExit !== appProcess) {
            console.error(
              chalk.red(`Fraq application exited with code ${exitCode}; waiting for a configuration change.`),
            );
          }
        });
      } catch (error) {
        this.updateSources(accessedFiles, false);
        const state = this.getState();
        if (state !== 'stopping' && state !== 'stopped') {
          console.error(chalk.red(`Failed to reload the Fraq application:\n${describeError(error)}`));
        }
      }
    }
  }
}

export const AppLifecycle = defineContext<AppLifecycleOptions>()
  .subsystems<AppLifecycleSystems>(({ rootOptions, getState, subsystem }) => {
    if (!rootOptions) {
      throw new Error('App lifecycle requires root options.');
    }
    const dependencies: LifecycleDependencies = {
      createSources: createConfigSourceRegistry,
      install: installAppDependencies,
      spawn: spawnAppProcess,
      writeFiles: writeAppFiles,
      ...rootOptions.dependencies,
    };
    const watch: WatchAppOptions = {
      initialFiles: new Set(rootOptions.initialFiles),
      prepare: rootOptions.prepare,
    };
    const application = subsystem({
      name: 'application',
      create: () => new ApplicationManager(watch, dependencies, getState),
      activate: (manager) => manager.reconcile(),
      suspend: (manager) => manager.suspend(),
      deactivate: (manager) => manager.deactivate(),
    });
    const sources = subsystem({
      name: 'sources',
      create: () =>
        dependencies.createSources({
          files: watch.initialFiles,
          onChange: (changedFiles) => application.filesChanged(changedFiles),
          onError: (error) => {
            console.error(chalk.red(`Configuration watcher failed: ${describeError(error)}`));
          },
        }),
      deactivate: (registry) => registry.close(),
    });
    return { application, sources };
  })
  .builtins<AppLifecycleBuiltins>(({ systems }) => ({
    reconcile: () => systems.application.reconcile(),
    shutdown: (signal) => systems.application.shutdown(signal),
  }))
  .wire(({ context, systems }) => {
    systems.application.attachSources(systems.sources);
    systems.application.bindStop(() => context.stop());
  })
  .build();

export async function startWatchedApp(options: WatchAppOptions): Promise<number> {
  const lifecycle = AppLifecycle.create(options);
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
    await lifecycle.start();
    const signal = await signalReceived;
    await lifecycle.shutdown(signal);
    return 128 + (osConstants.signals[signal] ?? 1);
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  }
}
