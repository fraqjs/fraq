import chalk from 'chalk';

import type { Config } from '../config';
import type { PackageManagerInfo } from '../package-manager';
import { getAppPath } from '../paths';
import { generateAppPackageJson } from './package-json';
import { installAppDependencies, startAppProcess } from './runner';
import { buildStartScript } from './start-script';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
  if (runInstall) {
    console.log(chalk.cyan(`Installing application dependencies with ${pmInfo.name}...`));
    const result = await installAppDependencies(pmInfo);
    if (result !== 0) {
      console.error(chalk.red(`Package manager install failed with exit code ${result}.`));
      return result;
    }
  }
  console.log(chalk.cyan('Starting the Fraq application...'));
  return startAppProcess();
}

export async function startInstall(
  config: Config,
  pmInfo: PackageManagerInfo & { commandPath: string },
): Promise<number> {
  const appPath = getAppPath();
  mkdirSync(appPath, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(appPath, 'package.json'), `${JSON.stringify(generateAppPackageJson(config), null, 2)}\n`);
  return installAppDependencies(pmInfo);
}
