import type { PackageManagerName } from '../package-manager';
import { getAppPath } from '../paths';

import { type ChildProcess, spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

interface PackageManagerCommand {
  name: PackageManagerName;
  commandPath: string;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  forwardedSignal?: NodeJS.Signals;
}

const terminationSignals: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

function killChildProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the signal and this handler.
    }
  }
  child.kill(signal);
}

export function waitForChild(child: ChildProcess): Promise<ChildResult> {
  let forwardedSignal: NodeJS.Signals | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of terminationSignals) {
    const handler = () => {
      const signalToForward = forwardedSignal === undefined ? signal : 'SIGKILL';
      forwardedSignal ??= signal;
      killChildProcessGroup(child, signalToForward);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  return new Promise((resolve, reject) => {
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
    };

    child.once('error', (error) => {
      removeSignalHandlers();
      reject(error);
    });
    child.once('close', (code, signal) => {
      removeSignalHandlers();
      resolve({ code, signal, forwardedSignal });
    });
  });
}

export function installAppDependencies(packageManager: PackageManagerCommand): ChildProcess {
  const appPath = getAppPath();
  const options = {
    cwd: appPath,
    detached: process.platform !== 'win32',
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

  if (process.platform === 'win32') {
    return spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `"${packageManager.commandPath}" install`, ...additionalArgs],
      options,
    );
  }
  return spawn(packageManager.commandPath, ['install', ...additionalArgs], options);
}

export function startAppProcess(): ChildProcess {
  return spawn(process.execPath, ['index.js'], {
    cwd: getAppPath(),
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: 'inherit',
  });
}

export function exitCodeFromChildResult(result: ChildResult): number {
  if (result.forwardedSignal) {
    return 128 + (osConstants.signals[result.forwardedSignal] ?? 1);
  }
  if (result.signal) {
    return 128 + (osConstants.signals[result.signal] ?? 1);
  }
  return result.code ?? 1;
}
