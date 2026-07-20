import chalk from 'chalk';

import type { Config } from '../config';
import { ensureAppPaths, getAppPath } from '../paths';
import type { PackageManagerInfo } from '../util/package-manager';
import { generateAppPackageJson } from './package-json';
import { exitCodeFromChildResult, installAppDependencies, startAppProcess, waitForChild } from './process';
import { buildStartScript } from './start-script';

import { writeFileSync } from 'node:fs';
import path from 'node:path';

export { generateAppPackageJson } from './package-json';
export { buildStartScript } from './start-script';

export interface StartAppParams {
  config: Config;
  pmInfo: PackageManagerInfo & { commandPath: string };
  runInstall: boolean;
}

export async function startApp({ config, pmInfo, runInstall }: StartAppParams): Promise<number> {
  ensureAppPaths();
  const appPath = getAppPath();
  writeFileSync(path.resolve(appPath, 'package.json'), `${JSON.stringify(generateAppPackageJson(config), null, 2)}\n`);
  writeFileSync(path.resolve(appPath, 'index.js'), `${buildStartScript(config)}\n`);

  if (runInstall) {
    const installResult = await startInstall(pmInfo);
    if (installResult !== 0) {
      console.error(chalk.red(`Package manager install failed with exit code ${installResult}.`));
      process.exit(1);
    }
  }

  const appResult = await waitForChild(startAppProcess());
  return exitCodeFromChildResult(appResult);
}

export async function startInstall(pmInfo: PackageManagerInfo & { commandPath: string }): Promise<number> {
  ensureAppPaths();
  const installResult = await waitForChild(installAppDependencies(pmInfo));
  return exitCodeFromChildResult(installResult);
}
