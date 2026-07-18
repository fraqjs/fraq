import type { Config } from './config';
import type { ContextConfig } from './config/v1';
import { normalizePluginName } from './dependency';
import type { PackageManagerName } from './package-manager';
import { appPath } from './paths';

import { type ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';

interface PackageJson {
  name: string;
  private: true;
  type: 'module';
  dependencies: Record<string, string>;
}

interface PackageManagerCommand {
  name: PackageManagerName;
  commandPath: string;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  forwardedSignal?: NodeJS.Signals;
}

function generateAppPackageJson(config: Config) {
  const packageJson: PackageJson = {
    name: 'fraq-app',
    private: true,
    type: 'module',
    dependencies: {},
  };
  packageJson.dependencies['@fraqjs/fraq'] = config.fraqVersion;
  for (const [pluginName, version] of Object.entries(config.versions)) {
    packageJson.dependencies[normalizePluginName(pluginName)] = version;
  }
  if (config.additionalDependencies) {
    for (const [dependency, version] of Object.entries(config.additionalDependencies)) {
      packageJson.dependencies[dependency] = version;
    }
  }
  packageJson.dependencies['@fraqjs/color-log'] = '0.2.0';
  return packageJson;
}

function buildStartScript(config: Config) {
  const lines: string[] = [];
  function l(line: string = '') {
    lines.push(line);
  }

  l(
    `
#!/usr/bin/env node

import { Context } from '@fraqjs/fraq';
import { createColoredLogHandler } from '@fraqjs/color-log';

const ctx = Context.fromUrl(${JSON.stringify(config.milky.url)}, {
  accessToken: ${JSON.stringify(config.milky.accessToken)},
  installEventSource: ${JSON.stringify(config.milky.connectEvent)},
  logHandler: createColoredLogHandler({ minLevel: ${JSON.stringify(config.logging.minLevel)} }),
});
    `.trim(),
  );
  l();

  let nextContextId = 0;
  function buildContextPart(parentContextName: string, contextConfig: ContextConfig) {
    for (const [pluginName, pluginConfig] of Object.entries(contextConfig.plugins ?? {})) {
      l(
        `${parentContextName}.install((await import(${JSON.stringify(normalizePluginName(pluginName))})).default, ${JSON.stringify(pluginConfig)});`,
      );
    }
    for (const [forkName, forkConfig] of Object.entries(contextConfig.forks ?? {})) {
      const forkContextName = `context${++nextContextId}`;
      l(`const ${forkContextName} = ${parentContextName}.fork(${JSON.stringify(forkName)});`);
      buildContextPart(forkContextName, forkConfig);
    }
  }
  buildContextPart('ctx', config);

  l();

  l(
    `
let shutdownPromise;

async function shutdown(signal) {
  shutdownPromise ??= (async () => {
    ctx.logger.info(\`Shutting down after receiving \${signal}...\`);
    await ctx.stop();
  })();

  try {
    await shutdownPromise;
    process.exit(0);
  } catch (error) {
    ctx.logger.error('Failed to shut down cleanly.', error);
    process.exit(1);
  }
}

const terminationSignals =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

for (const signal of terminationSignals) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

await ctx.start();
    `.trim(),
  );

  return lines.join('\n');
}

const terminationSignals: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 1);
}

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

function waitForChild(child: ChildProcess): Promise<ChildResult> {
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

    // @ts-expect-error Node.js types are missing the `once` method on ChildProcess
    child.once('error', (error) => {
      removeSignalHandlers();
      reject(error);
    });
    // @ts-expect-error Node.js types are missing the `once` method on ChildProcess
    child.once('close', (code, signal) => {
      removeSignalHandlers();
      resolve({ code, signal, forwardedSignal });
    });
  });
}

function spawnPackageManager(packageManager: PackageManagerCommand): ChildProcess {
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

export async function startApp(config: Config, packageManager: PackageManagerCommand): Promise<number> {
  writeFileSync(path.resolve(appPath, 'package.json'), `${JSON.stringify(generateAppPackageJson(config), null, 2)}\n`);
  writeFileSync(path.resolve(appPath, 'index.js'), `${buildStartScript(config)}\n`);

  const installResult = await waitForChild(spawnPackageManager(packageManager));
  if (installResult.forwardedSignal) {
    return signalExitCode(installResult.forwardedSignal);
  }
  if (installResult.signal) {
    return signalExitCode(installResult.signal);
  }
  if (installResult.code !== 0) {
    throw new Error(`Package manager install failed with exit code ${installResult.code ?? 'unknown'}.`);
  }

  const appProcess = spawn(process.execPath, ['index.js'], {
    cwd: appPath,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: 'inherit',
  });
  const appResult = await waitForChild(appProcess);
  if (appResult.forwardedSignal) {
    return signalExitCode(appResult.forwardedSignal);
  }
  if (appResult.signal) {
    return signalExitCode(appResult.signal);
  }
  return appResult.code ?? 1;
}
