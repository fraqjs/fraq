import type { Config } from '../config';
import type { PackageManagerName } from '../package-manager';
import { ensureAppPaths, getAppPath } from '../paths';
import { generateAppPackageJson } from './package-json';
import { exitCodeFromChildResult, installAppDependencies, startAppProcess, waitForChild } from './process';
import { buildStartScript } from './start-script';

import { writeFileSync } from 'node:fs';
import path from 'node:path';

export { generateAppPackageJson } from './package-json';
export { buildStartScript } from './start-script';

interface PackageManagerCommand {
  name: PackageManagerName;
  commandPath: string;
}

export async function startApp(config: Config, packageManager: PackageManagerCommand): Promise<number> {
  ensureAppPaths();
  const appPath = getAppPath();
  writeFileSync(path.resolve(appPath, 'package.json'), `${JSON.stringify(generateAppPackageJson(config), null, 2)}\n`);
  writeFileSync(path.resolve(appPath, 'index.js'), `${buildStartScript(config)}\n`);

  const installResult = await waitForChild(installAppDependencies(packageManager));
  if (installResult.forwardedSignal || installResult.signal) {
    return exitCodeFromChildResult(installResult);
  }
  if (installResult.code !== 0) {
    throw new Error(`Package manager install failed with exit code ${installResult.code ?? 'unknown'}.`);
  }

  const appResult = await waitForChild(startAppProcess());
  return exitCodeFromChildResult(appResult);
}
