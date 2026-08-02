import chalk from 'chalk';

import type { Config } from '../config';
import type { PackageManagerInfo } from '../package-manager';
import { ensureAppPaths } from '../paths';
import { writeAppFiles } from './files';
import { installAppDependencies, startAppProcess } from './runner';

export interface StartAppParams {
  config: Config;
  pmInfo: PackageManagerInfo & { commandPath: string };
  runInstall: boolean;
}

export async function startApp({ config, pmInfo, runInstall }: StartAppParams): Promise<number> {
  writeAppFiles(config);

  if (runInstall) {
    console.log(chalk.cyan(`Installing application dependencies with ${chalk.bold(chalk.magenta(pmInfo.name))}...`));
    const installResult = await startInstall(pmInfo);
    if (installResult !== 0) {
      console.error(chalk.red(`Package manager install failed with exit code ${installResult}.`));
      return 1;
    }
    console.log();
  }

  console.log(chalk.cyan('Starting the Fraq application...'));
  return startAppProcess();
}

export async function startInstall(pmInfo: PackageManagerInfo & { commandPath: string }): Promise<number> {
  ensureAppPaths();
  return installAppDependencies(pmInfo);
}
