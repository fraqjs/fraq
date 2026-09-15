import type { ControlRequest, ControlResponse } from '@fraqjs/cli-protocol';
import { execa, execaNode, type ResultPromise } from 'execa';

import type { PackageManagerInfo } from '../package-manager';
import { getAppPath } from '../paths';
import type { LogRegistry } from './logs';

import { constants as osConstants } from 'node:os';
import path from 'node:path';

export interface RunningProcess {
  readonly exit: Promise<number>;
  kill(signal: NodeJS.Signals): boolean;
}

export interface RunningAppProcess extends RunningProcess {
  readonly ready: Promise<void>;
}

function toRunningProcess(child: ResultPromise): RunningProcess {
  return {
    exit: child.then((result) => {
      if (result.signal) {
        return 128 + (osConstants.signals[result.signal] ?? 1);
      }
      return result.exitCode ?? 1;
    }),
    kill: (signal) => child.kill(signal),
  };
}

export function spawnInstallProcess(
  packageManager: PackageManagerInfo & { commandPath: string },
  appPath = getAppPath(),
  logs?: LogRegistry,
): RunningProcess {
  const options = {
    cwd: appPath,
    env:
      packageManager.name === 'yarn'
        ? {
            ...process.env,
            YARN_NODE_LINKER: 'node-modules',
          }
        : process.env,
    stdin: 'inherit' as const,
  };

  const additionalArgs = [];
  if (packageManager.name === 'pnpm') {
    additionalArgs.push('--ignore-workspace');
  }
  if (packageManager.name === 'npm') {
    additionalArgs.push('--legacy-peer-deps');
  }

  return toRunningProcess(
    execa(packageManager.commandPath, ['install', ...additionalArgs], {
      ...options,
      stdout: logs ? ['inherit', logs.output('install', 'stdout')] : 'inherit',
      stderr: logs ? ['inherit', logs.output('install', 'stderr')] : 'inherit',
      buffer: false,
      forceKillAfterDelay: 5_000,
      killDescendants: true,
      reject: false,
    }),
  );
}

export function spawnAppProcess(
  entryPoint = path.join(getAppPath(), 'index.js'),
  startupTimeoutMs = 60_000,
  options: { logs?: LogRegistry; onRequest?: (request: ControlRequest) => Promise<ControlResponse> } = {},
): RunningAppProcess {
  const child = execaNode(entryPoint, {
    cwd: getAppPath(),
    env: { ...process.env, FRAQ_CLI_WATCH: options.onRequest ? '1' : undefined },
    forceKillAfterDelay: 5_000,
    killDescendants: true,
    nodeOptions: [],
    reject: false,
    stdin: 'inherit',
    ipc: true,
    stdout: options.logs ? ['inherit', options.logs.output('app', 'stdout')] : 'inherit',
    stderr: options.logs ? ['inherit', options.logs.output('app', 'stderr')] : 'inherit',
    buffer: false,
  });
  if (options.onRequest) {
    const handle = options.onRequest;
    void (async () => {
      for await (const message of child.getEachMessage({ reference: false })) {
        // Serialize requests and responses: a child cannot grow an unbounded outbound queue.
        await child.sendMessage(await handle(message as ControlRequest));
      }
    })().catch(() => {});
  }
  const running = toRunningProcess(child);
  let timeout: NodeJS.Timeout;
  const ready = Promise.race([
    child
      .getOneMessage({
        reference: false,
        filter: (message) =>
          message !== null &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'fraq:ready' &&
          'version' in message &&
          message.version === 1,
      })
      .then(
        () => {},
        (error: unknown) => {
          throw new Error('Fraq application exited or disconnected before becoming ready.', { cause: error });
        },
      ),
    running.exit.then((exitCode) => {
      throw new Error(`Fraq application exited before becoming ready (code ${exitCode}).`);
    }),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Fraq application did not become ready within ${startupTimeoutMs}ms.`));
      }, startupTimeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
  // A caller may be waiting for exit rather than readiness.
  void ready.catch(() => {});
  return { ...running, ready };
}

function spawnDirectAppProcess(): RunningProcess {
  return toRunningProcess(
    execaNode('index.js', {
      cwd: getAppPath(),
      env: process.env,
      forceKillAfterDelay: 5_000,
      killDescendants: true,
      nodeOptions: [],
      reject: false,
      stdio: 'inherit',
      ipc: false,
    }),
  );
}

export interface ProcessDependencies {
  spawn: typeof spawnAppProcess;
  install: typeof spawnInstallProcess;
  run: typeof spawnDirectAppProcess;
}

export class ProcessRegistry {
  private readonly children = new Set<RunningProcess>();
  private readonly stopping = new Map<RunningProcess, { promise: Promise<void>; signal: NodeJS.Signals }>();
  private readonly dependencies: ProcessDependencies;
  private current?: RunningAppProcess;
  private stopSignal?: NodeJS.Signals;

  constructor(
    dependencies: Partial<ProcessDependencies> = {},
    private readonly logs?: LogRegistry,
    private readonly onRequest?: (request: ControlRequest) => Promise<ControlResponse>,
    private readonly onExit: (code: number) => void = () => {},
  ) {
    this.dependencies = {
      spawn: spawnAppProcess,
      install: spawnInstallProcess,
      run: spawnDirectAppProcess,
      ...dependencies,
    };
  }

  get running(): boolean {
    return this.current !== undefined;
  }

  private track<T extends RunningProcess>(child: T): T {
    this.children.add(child);
    void child.exit.then(
      () => this.children.delete(child),
      () => this.children.delete(child),
    );
    return child;
  }

  install(packageManager: PackageManagerInfo & { commandPath: string }, directory = getAppPath()): Promise<number> {
    if (this.stopSignal) return Promise.reject(new Error('Application session is stopping.'));
    return this.track(this.dependencies.install(packageManager, directory, this.logs)).exit;
  }

  run(): Promise<number> {
    if (this.stopSignal) return Promise.reject(new Error('Application session is stopping.'));
    return this.track(this.dependencies.run()).exit;
  }

  async launch(entryPoint: string): Promise<void> {
    if (this.stopSignal) throw new Error('Application session is stopping.');
    if (this.current) throw new Error('An application process is already running.');
    const child = this.track(
      this.dependencies.spawn(entryPoint, undefined, {
        logs: this.logs,
        onRequest: this.onRequest,
      }),
    );
    this.current = child;
    await child.ready;
    void child.exit.then((code) => {
      if (this.current !== child) return;
      this.current = undefined;
      if (!this.stopSignal && !this.stopping.has(child)) this.onExit(code);
    });
  }

  stopApplication(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    return this.current ? this.stop(this.current, signal) : Promise.resolve();
  }

  private stop(child: RunningProcess, signal: NodeJS.Signals): Promise<void> {
    const pending = this.stopping.get(child);
    if (pending) {
      if (signal === 'SIGKILL' && pending.signal !== 'SIGKILL') {
        pending.signal = signal;
        child.kill(signal);
      }
      return pending.promise;
    }
    child.kill(signal);
    const stopped = child.exit.then(() => {
      if (this.current === child) this.current = undefined;
      this.stopping.delete(child);
    });
    this.stopping.set(child, { promise: stopped, signal });
    return stopped;
  }

  shutdown(signal: NodeJS.Signals = this.stopSignal ?? 'SIGTERM'): void {
    this.stopSignal = signal;
    for (const child of this.children) void this.stop(child, signal);
  }

  async close(): Promise<void> {
    this.shutdown(this.stopSignal ?? 'SIGTERM');
    await Promise.all([...this.children].map((child) => child.exit));
  }
}
