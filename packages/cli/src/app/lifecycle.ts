import { type ContextState, defineContext } from '@fraqjs/kernel';
import chalk from 'chalk';

import type { Config } from '../config';
import { type ConfigSourceRegistry, createConfigSourceRegistry } from '../config/sources';
import type { PackageManagerInfo } from '../package-manager';
import { type RunningAppProcess, spawnAppProcess } from './runner';
import { dependencyFingerprint, type Runtime, RuntimeRegistry, type RuntimeStore } from './runtimes';
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
  spawn: typeof spawnAppProcess;
  createRuntimes: () => RuntimeStore;
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
  waitForExit(): Promise<number>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ApplicationManager {
  private readonly initialFiles: Set<string>;
  private watchedFiles: Set<string>;
  private sources?: ConfigSourceRegistry;
  private currentProcess?: RunningAppProcess;
  private expectedExit?: RunningAppProcess;
  private activeStop?: { process: RunningAppProcess; promise: Promise<void> };
  private restartFiles = new Set<string>();
  private workspaceRevision = 0;
  private appliedWorkspaceRevision = 0;
  private dirty = false;
  private startupFailed = false;
  private activeReconcile?: Promise<void>;
  private stopSignal?: NodeJS.Signals;
  private suspendedProcess?: Promise<void>;
  private stopContext?: () => Promise<void>;
  private readonly runtimes: RuntimeStore;
  private lastSuccessful?: Runtime;
  private resolveExit!: (code: number) => void;
  private readonly exit = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    private readonly options: WatchAppOptions,
    private readonly dependencies: LifecycleDependencies,
    private readonly getState: () => ContextState,
  ) {
    this.initialFiles = new Set(options.initialFiles);
    this.runtimes = dependencies.createRuntimes();
    this.watchedFiles = new Set(this.initialFiles);
  }

  waitForExit(): Promise<number> {
    return this.exit;
  }

  attachSources(sources: ConfigSourceRegistry): void {
    this.sources = sources;
    sources.update(this.watchedFiles);
  }

  bindStop(stopContext: () => Promise<void>): void {
    this.stopContext = stopContext;
  }

  filesChanged(changedFiles: ReadonlySet<string>): void {
    if ([...changedFiles].some((file) => this.restartFiles.has(path.resolve(file)))) {
      this.workspaceRevision++;
    }
    void this.reconcile();
  }

  reconcile(): Promise<void> {
    const state = this.getState();
    if (this.startupFailed || this.stopSignal !== undefined || state === 'stopping' || state === 'stopped') {
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
    this.runtimes.close();
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

  // Readiness is a protocol boundary: the process is not a successful runtime until
  // ctx.start() has completed, and shutdown must also interrupt this wait.
  private async launch(runtime: Runtime): Promise<boolean> {
    const appProcess = this.dependencies.spawn(runtime.entryPoint);
    this.currentProcess = appProcess;
    await appProcess.ready;
    if (this.stopSignal !== undefined || this.getState() !== 'started') {
      return false;
    }
    this.lastSuccessful = runtime;
    void appProcess.exit.then((exitCode) => {
      if (this.currentProcess !== appProcess) {
        return;
      }
      this.currentProcess = undefined;
      if (this.getState() === 'started' && this.expectedExit !== appProcess) {
        console.error(chalk.red(`Fraq application exited with code ${exitCode}; waiting for a configuration change.`));
      }
    });
    return true;
  }

  private async runReconcileLoop(): Promise<void> {
    while (this.dirty && this.stopSignal === undefined && this.getState() === 'started') {
      this.dirty = false;
      const accessedFiles = new Set<string>();
      let launching = false;

      try {
        const prepared = await this.options.prepare(accessedFiles);
        this.updateSources(accessedFiles, false);
        this.restartFiles = new Set(Array.from(prepared.restartFiles ?? [], (file) => path.resolve(file)));
        if (this.dirty || this.stopSignal !== undefined || this.getState() !== 'started') {
          continue;
        }

        const nextStartScript = buildStartScript(prepared.config);
        const nextDependencies = dependencyFingerprint(prepared.config, prepared.packageManager);
        const workspaceChanged = this.workspaceRevision !== this.appliedWorkspaceRevision;
        const dependenciesChanged = workspaceChanged || nextDependencies !== this.lastSuccessful?.fingerprint;
        const applicationChanged = workspaceChanged || nextStartScript !== this.lastSuccessful?.startScript;
        if (this.currentProcess && !dependenciesChanged && !applicationChanged) {
          this.updateSources(accessedFiles, true);
          continue;
        }

        // Candidate installs use a separate directory while the current process stays alive.
        const revision = this.workspaceRevision;
        const runtime = await this.runtimes.prepare(prepared.config, prepared.packageManager, {
          refresh: workspaceChanged,
        });
        if (this.stopSignal !== undefined || this.getState() !== 'started' || this.dirty) {
          continue;
        }
        const restarting = this.currentProcess !== undefined;
        await this.stopCurrentProcess();
        if (this.stopSignal !== undefined || this.getState() !== 'started') {
          break;
        }
        console.log(chalk.cyan(restarting ? 'Restarting the Fraq application...' : 'Starting the Fraq application...'));
        launching = true;
        if (!(await this.launch(runtime))) {
          break;
        }
        this.appliedWorkspaceRevision = revision;
        this.updateSources(accessedFiles, true);
      } catch (error) {
        this.updateSources(accessedFiles, false);
        if (this.stopSignal !== undefined || this.getState() !== 'started') {
          break;
        }
        console.error(chalk.red(`Failed to apply the Fraq configuration:\n${describeError(error)}`));
        if (launching) {
          await this.stopCurrentProcess();
        }
        if (this.stopSignal !== undefined || this.getState() !== 'started') {
          break;
        }
        if (!this.lastSuccessful) {
          this.startupFailed = true;
          this.dirty = false;
          this.resolveExit(1);
          break;
        }
        if (this.currentProcess) {
          console.error(
            chalk.yellow('Keeping the current successful runtime; configuration files have not been reverted.'),
          );
          continue;
        }
        console.error(
          chalk.yellow('Falling back to the last successful runtime; configuration files have not been reverted.'),
        );
        try {
          if (await this.launch(this.lastSuccessful)) {
            continue;
          }
        } catch (fallbackError) {
          console.error(
            chalk.red(`The last successful runtime also failed to start:\n${describeError(fallbackError)}`),
          );
          await this.stopCurrentProcess();
        }
        if (this.stopSignal === undefined) {
          console.error(chalk.yellow('No running application; waiting for a configuration change.'));
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
      spawn: spawnAppProcess,
      createRuntimes: () => new RuntimeRegistry(),
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
    waitForExit: () => systems.application.waitForExit(),
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
    const result = await Promise.race([
      lifecycle.waitForExit(),
      signalReceived.then((signal) => 128 + (osConstants.signals[signal] ?? 1)),
    ]);
    return receivedSignal === undefined ? result : 128 + (osConstants.signals[receivedSignal] ?? 1);
  } finally {
    try {
      await lifecycle.shutdown(receivedSignal);
    } finally {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
    }
  }
}
