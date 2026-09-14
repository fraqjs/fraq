import { execa, execaNode, type ResultPromise } from 'execa';

import type { PackageManagerInfo } from '../package-manager';
import { getAppPath } from '../paths';

import { constants as osConstants } from 'node:os';
import path from 'node:path';

const terminationSignals: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

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

async function waitForProcessExit(child: RunningProcess): Promise<number> {
  let forwardedSignal: NodeJS.Signals | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of terminationSignals) {
    const handler = () => {
      const signalToForward = forwardedSignal === undefined ? signal : 'SIGKILL';
      forwardedSignal ??= signal;
      child.kill(signalToForward);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const exitCode = await child.exit;
    if (forwardedSignal) {
      return 128 + (osConstants.signals[forwardedSignal] ?? 1);
    }
    return exitCode;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  }
}

export function installAppDependencies(
  packageManager: PackageManagerInfo & { commandPath: string },
  appPath = getAppPath(),
): Promise<number> {
  const options = {
    cwd: appPath,
    env:
      packageManager.name === 'yarn'
        ? {
            ...process.env,
            YARN_NODE_LINKER: 'node-modules',
          }
        : process.env,
    stdio: 'inherit' as const,
  };

  const additionalArgs = [];
  if (packageManager.name === 'pnpm') {
    additionalArgs.push('--ignore-workspace');
  }
  if (packageManager.name === 'npm') {
    additionalArgs.push('--legacy-peer-deps');
  }

  return waitForProcessExit(
    toRunningProcess(
      execa(packageManager.commandPath, ['install', ...additionalArgs], {
        ...options,
        forceKillAfterDelay: 5_000,
        killDescendants: true,
        reject: false,
      }),
    ),
  );
}

export function spawnAppProcess(
  entryPoint = path.join(getAppPath(), 'index.js'),
  startupTimeoutMs = 60_000,
): RunningAppProcess {
  const child = execaNode(entryPoint, {
    cwd: getAppPath(),
    env: process.env,
    forceKillAfterDelay: 5_000,
    killDescendants: true,
    nodeOptions: [],
    reject: false,
    stdio: 'inherit',
    ipc: true,
  });
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

export function startAppProcess(): Promise<number> {
  return waitForProcessExit(
    toRunningProcess(
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
    ),
  );
}
