import { execa, execaNode, type ResultPromise } from 'execa';

import type { PackageManagerInfo } from '../package-manager';
import { getAppPath } from '../paths';

import { constants as osConstants } from 'node:os';

const terminationSignals: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

async function waitForProcessExit(child: ResultPromise): Promise<number> {
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
    const result = await child;
    if (forwardedSignal) {
      return 128 + (osConstants.signals[forwardedSignal] ?? 1);
    }
    if (result.signal) {
      return 128 + (osConstants.signals[result.signal] ?? 1);
    }
    return result.exitCode ?? 1;
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
    execa(packageManager.commandPath, ['install', ...additionalArgs], {
      ...options,
      killDescendants: true,
      reject: false,
    }),
  );
}

export function startAppProcess(): Promise<number> {
  return waitForProcessExit(
    execaNode('index.js', {
      cwd: getAppPath(),
      env: process.env,
      killDescendants: true,
      nodeOptions: [],
      reject: false,
      stdio: 'inherit',
    }),
  );
}
