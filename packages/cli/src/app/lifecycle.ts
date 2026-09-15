import { type AppStatus, ControlError } from '@fraqjs/cli-protocol';
import type { ContextState } from '@fraqjs/kernel';
import chalk from 'chalk';

import type { Config } from '../config';
import type { ConfigSourceRegistry } from '../config/sources';
import type { PackageManagerInfo } from '../package-manager';
import type { LogRegistry } from './logs';
import type { ProcessRegistry } from './processes';
import { dependencyFingerprint, type Runtime, type RuntimeStore } from './runtimes';
import { buildStartScript } from './start-script';

import path from 'node:path';

export interface PreparedApp {
  config: Config;
  packageManager: PackageManagerInfo & { commandPath: string };
  restartFiles?: Iterable<string>;
}

export interface WatchAppOptions {
  initialFiles: Iterable<string>;
  prepare: (accessedFiles: Set<string>) => Promise<PreparedApp>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LifecycleManager {
  private readonly initialFiles: Set<string>;
  private watchedFiles: Set<string>;
  private restartFiles = new Set<string>();
  private workspaceRevision = 0;
  private appliedWorkspaceRevision = 0;
  private dirty = false;
  private startupFailed = false;
  private restartRequested = false;
  private restartTimer?: NodeJS.Timeout;
  private statusState: AppStatus['state'] = 'starting';
  private fallback = false;
  private lastError: string | null = null;
  private generation = 0;
  private activeReconcile?: Promise<void>;
  private stopSignal?: NodeJS.Signals;
  private stopContext?: () => Promise<void>;
  private lastSuccessful?: Runtime;
  private resolveExit!: (code: number) => void;
  private readonly exit = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    private readonly options: WatchAppOptions,
    private readonly runtimes: RuntimeStore,
    private readonly processes: ProcessRegistry,
    private readonly sources: ConfigSourceRegistry,
    private readonly getState: () => ContextState,
    private readonly logs: LogRegistry,
  ) {
    this.initialFiles = new Set(options.initialFiles);
    this.watchedFiles = new Set(this.initialFiles);
  }

  status(): AppStatus {
    return {
      session: this.logs.session,
      state: this.statusState,
      fallback: this.fallback,
      error: this.lastError,
      generation: this.generation,
      busy: this.activeReconcile !== undefined || this.restartTimer !== undefined || this.restartRequested,
    };
  }

  restart(): void {
    if (this.stopSignal || this.startupFailed || !this.lastSuccessful) {
      throw new ControlError('unavailable', '当前应用无法重启。');
    }
    if (this.statusState === 'restarting' || this.restartRequested) return;
    this.restartRequested = true;
    this.logs.message('Restart requested from WebUI.');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.reconcile();
    }, 150);
  }

  waitForExit(): Promise<number> {
    return this.exit;
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
    this.suspend();
    this.processes.shutdown(signal);
    if (!this.stopContext) {
      return Promise.reject(new Error('App lifecycle has not been wired.'));
    }
    return this.stopContext();
  }

  suspend(): void {
    this.dirty = false;
    this.stopSignal ??= 'SIGTERM';
    this.statusState = 'stopped';
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.restartRequested = false;
  }

  async deactivate(): Promise<void> {
    await this.activeReconcile;
  }

  private updateSources(accessedFiles: Set<string>, successful: boolean): void {
    this.watchedFiles = successful
      ? new Set([...this.initialFiles, ...accessedFiles])
      : new Set([...this.watchedFiles, ...accessedFiles]);
    this.sources.update(this.watchedFiles);
  }

  applicationExited(exitCode: number): void {
    if (this.stopSignal || this.getState() !== 'started') return;
    this.statusState = 'stopped';
    this.logs.error(chalk.red(`Fraq application exited with code ${exitCode}; waiting for a configuration change.`));
  }

  // Readiness is a protocol boundary: the process is not a successful runtime until
  // ctx.start() has completed, and shutdown must also interrupt this wait.
  private async launch(runtime: Runtime): Promise<boolean> {
    await this.processes.launch(runtime.entryPoint);
    if (this.stopSignal !== undefined || this.getState() !== 'started') {
      return false;
    }
    this.lastSuccessful = runtime;
    this.statusState = this.processes.running ? 'running' : 'stopped';
    this.generation++;
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
        if (this.processes.running && !dependenciesChanged && !applicationChanged && !this.restartRequested) {
          this.updateSources(accessedFiles, true);
          this.lastError = null;
          this.fallback = false;
          continue;
        }

        this.statusState = this.lastSuccessful ? 'restarting' : 'starting';
        // Candidate installs use a separate directory while the current process stays alive.
        const revision = this.workspaceRevision;
        const runtime = await this.runtimes.prepare(prepared.config, prepared.packageManager, {
          refresh: workspaceChanged,
        });
        if (this.stopSignal !== undefined || this.getState() !== 'started' || this.dirty) {
          continue;
        }
        this.restartRequested = false;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
        const restarting = this.processes.running;
        await this.processes.stopApplication();
        if (this.stopSignal !== undefined || this.getState() !== 'started') {
          break;
        }
        this.logs.message(
          chalk.cyan(restarting ? 'Restarting the Fraq application...' : 'Starting the Fraq application...'),
        );
        launching = true;
        if (!(await this.launch(runtime))) {
          break;
        }
        this.appliedWorkspaceRevision = revision;
        this.lastError = null;
        this.fallback = false;
        this.updateSources(accessedFiles, true);
      } catch (error) {
        this.restartRequested = false;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
        this.lastError = describeError(error);
        this.updateSources(accessedFiles, false);
        if (this.stopSignal !== undefined || this.getState() !== 'started') {
          break;
        }
        this.logs.error(chalk.red(`Failed to apply the Fraq configuration:\n${describeError(error)}`));
        if (launching) {
          await this.processes.stopApplication();
        }
        if (this.stopSignal !== undefined || this.getState() !== 'started') {
          break;
        }
        if (!this.lastSuccessful) {
          this.startupFailed = true;
          this.statusState = 'stopped';
          this.dirty = false;
          this.resolveExit(1);
          break;
        }
        this.fallback = true;
        if (this.processes.running) {
          this.statusState = 'running';
          this.logs.error(
            chalk.yellow('Keeping the current successful runtime; configuration files have not been reverted.'),
          );
          continue;
        }
        this.logs.error(
          chalk.yellow('Falling back to the last successful runtime; configuration files have not been reverted.'),
        );
        try {
          if (await this.launch(this.lastSuccessful)) {
            continue;
          }
        } catch (fallbackError) {
          this.logs.error(
            chalk.red(`The last successful runtime also failed to start:\n${describeError(fallbackError)}`),
          );
          await this.processes.stopApplication();
          this.statusState = 'stopped';
          this.lastError += `\n回退失败: ${describeError(fallbackError)}`;
        }
        if (this.stopSignal === undefined) {
          this.logs.error(chalk.yellow('No running application; waiting for a configuration change.'));
        }
      }
    }
  }
}
