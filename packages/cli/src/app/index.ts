import type { AppStatus } from '@fraqjs/cli-protocol';
import { defineContext } from '@fraqjs/kernel';
import chalk from 'chalk';

import type { Config } from '../config';
import { ConfigEditor } from '../config/editor';
import { type ConfigSourceRegistry, createConfigSourceRegistry } from '../config/sources';
import type { PackageManagerInfo } from '../package-manager';
import { getAppPath } from '../paths';
import { CliControl } from './control';
import { LifecycleManager, type WatchAppOptions } from './lifecycle';
import { LogRegistry } from './logs';
import { generateAppPackageJson } from './package-json';
import { type ProcessDependencies, ProcessRegistry } from './processes';
import { RuntimeRegistry, type RuntimeStore } from './runtimes';
import { SignalRegistry } from './signals';
import { buildStartScript } from './start-script';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export { prepareApp, syncVersions } from './configuration';
export type { PreparedApp, WatchAppOptions } from './lifecycle';

export interface AppLifecycleOptions extends WatchAppOptions {
  dependencies?: Partial<
    ProcessDependencies & {
      createSources: typeof createConfigSourceRegistry;
      createRuntimes: (processes: ProcessRegistry, logs: LogRegistry) => RuntimeStore;
    }
  >;
}

interface SessionSystems {
  logs: LogRegistry;
  editor: ConfigEditor;
  processes: ProcessRegistry;
  runtimes: RuntimeStore;
  sources: ConfigSourceRegistry;
  lifecycle: LifecycleManager;
  control: CliControl;
  signals: SignalRegistry;
}

interface SessionBuiltins {
  reconcile(): Promise<void>;
  restart(): void;
  status(): AppStatus;
  shutdown(signal?: NodeJS.Signals): Promise<void>;
  waitForExit(): Promise<number>;
}

// One kernel context represents one watch session. Stop hooks release runtime
// directories only after deactivation has drained work and terminated processes.
export const AppLifecycle = defineContext<AppLifecycleOptions>()
  .subsystems<SessionSystems>(({ rootOptions, getState, subsystem }) => {
    if (!rootOptions) throw new Error('App lifecycle requires root options.');
    const options: WatchAppOptions = { initialFiles: new Set(rootOptions.initialFiles), prepare: rootOptions.prepare };
    const logs = subsystem({ name: 'logs', create: () => new LogRegistry(), stop: (value) => value.close() });
    const editor = subsystem({ name: 'editor', create: () => new ConfigEditor() });
    const processes: ProcessRegistry = subsystem({
      name: 'processes',
      create: () =>
        new ProcessRegistry(
          rootOptions.dependencies,
          logs,
          (request) => control.handle(request),
          (code) => lifecycle.applicationExited(code),
        ),
      suspend: (value) => value.shutdown(),
      deactivate: (value) => value.close(),
    });
    const runtimes: RuntimeStore = subsystem({
      name: 'runtimes',
      create: () =>
        rootOptions.dependencies?.createRuntimes?.(processes, logs) ??
        new RuntimeRegistry(getAppPath(), (pm, directory) => processes.install(pm, directory), logs),
      stop: (value) => value.close(),
    });
    const sources: ConfigSourceRegistry = subsystem({
      name: 'sources',
      create: () =>
        (rootOptions.dependencies?.createSources ?? createConfigSourceRegistry)({
          files: options.initialFiles,
          onChange: (files) => {
            if (getState() === 'started' || getState() === 'starting') lifecycle.filesChanged(files);
          },
          onError: (error) =>
            logs.error(
              chalk.red(`Configuration watcher failed: ${error instanceof Error ? error.message : String(error)}`),
            ),
        }),
      deactivate: (value) => value.close(),
    });
    const lifecycle: LifecycleManager = subsystem({
      name: 'lifecycle',
      create: () => new LifecycleManager(options, runtimes, processes, sources, getState, logs),
      activate: (value) => value.reconcile(),
      suspend: (value) => value.suspend(),
      deactivate: (value) => value.deactivate(),
    });
    const control: CliControl = subsystem({
      name: 'control',
      create: () =>
        new CliControl(
          logs,
          () => lifecycle.status(),
          () => lifecycle.restart(),
          editor,
        ),
      suspend: (value) => value.close(),
    });
    // Keep signal handlers through deactivation so a second signal can force a pending exit.
    const signals = subsystem({
      name: 'signals',
      create: () =>
        new SignalRegistry((signal) => {
          void lifecycle.shutdown(signal).catch((error) => logs.error(String(error)));
        }),
      start: (value) => value.start(),
      stop: (value) => value.close(),
    });
    return { logs, editor, processes, runtimes, sources, lifecycle, control, signals };
  })
  .builtins<SessionBuiltins>(({ systems }) => ({
    reconcile: () => systems.lifecycle.reconcile(),
    restart: () => systems.lifecycle.restart(),
    status: () => systems.lifecycle.status(),
    shutdown: (signal) => systems.lifecycle.shutdown(signal),
    async waitForExit() {
      const result = await Promise.race([systems.lifecycle.waitForExit(), systems.signals.exit]);
      return systems.signals.exitCode ?? result;
    },
  }))
  .wire(({ context, systems }) => {
    systems.lifecycle.bindStop(() => context.stop());
  })
  .build();

export async function startWatchedApp(options: WatchAppOptions): Promise<number> {
  const session = AppLifecycle.create(options);
  try {
    await session.start();
    return await session.waitForExit();
  } finally {
    await session.shutdown();
  }
}

export interface StartAppParams {
  config: Config;
  pmInfo: PackageManagerInfo & { commandPath: string };
  runInstall: boolean;
}

export async function startApp({ config, pmInfo, runInstall }: StartAppParams): Promise<number> {
  const appPath = getAppPath();
  mkdirSync(appPath, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(appPath, 'index.js'), buildStartScript(config), { mode: 0o600 });
  writeFileSync(path.join(appPath, 'package.json'), `${JSON.stringify(generateAppPackageJson(config), null, 2)}\n`);
  const processes = new ProcessRegistry();
  const signals = new SignalRegistry((signal) => processes.shutdown(signal));
  signals.start();
  try {
    if (runInstall) {
      console.log(chalk.cyan(`Installing application dependencies with ${pmInfo.name}...`));
      const result = await processes.install(pmInfo);
      if (signals.exitCode !== undefined) return signals.exitCode;
      if (result !== 0) {
        console.error(chalk.red(`Package manager install failed with exit code ${result}.`));
        return result;
      }
    }
    console.log(chalk.cyan('Starting the Fraq application...'));
    const result = await processes.run();
    return signals.exitCode ?? result;
  } finally {
    try {
      await processes.close();
    } finally {
      signals.close();
    }
  }
}

export async function startInstall(
  config: Config,
  pmInfo: PackageManagerInfo & { commandPath: string },
): Promise<number> {
  const appPath = getAppPath();
  mkdirSync(appPath, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(appPath, 'package.json'), `${JSON.stringify(generateAppPackageJson(config), null, 2)}\n`);
  const processes = new ProcessRegistry();
  const signals = new SignalRegistry((signal) => processes.shutdown(signal));
  signals.start();
  try {
    const result = await processes.install(pmInfo);
    return signals.exitCode ?? result;
  } finally {
    try {
      await processes.close();
    } finally {
      signals.close();
    }
  }
}
