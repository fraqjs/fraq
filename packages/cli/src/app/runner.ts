import { execa, execaNode, type ResultPromise } from 'execa';

import type { PackageManagerInfo } from '../package-manager';
import { getAppPath } from '../paths';

import { constants as osConstants } from 'node:os';

const terminationSignals: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

export interface RunningProcess {
  readonly exit: Promise<number>;
  kill(signal: NodeJS.Signals): boolean;
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

export function installAppDependencies(packageManager: PackageManagerInfo & { commandPath: string }): Promise<number> {
  const appPath = getAppPath();
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

export function spawnAppProcess(): RunningProcess {
  return toRunningProcess(
    execaNode('index.js', {
      cwd: getAppPath(),
      env: process.env,
      forceKillAfterDelay: 5_000,
      killDescendants: true,
      nodeOptions: [],
      reject: false,
      stdio: 'inherit',
    }),
  );
}

export function startAppProcess(): Promise<number> {
  return waitForProcessExit(spawnAppProcess());
}
