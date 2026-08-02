import type { Config } from '../config';
import { ensureAppPaths, getAppPath } from '../paths';
import { generateAppPackageJson } from './package-json';
import { buildStartScript } from './start-script';

import { writeFileSync } from 'node:fs';
import path from 'node:path';

export function writeAppFiles(config: Config): void {
  ensureAppPaths();
  const appPath = getAppPath();
  writeFileSync(path.resolve(appPath, 'package.json'), `${JSON.stringify(generateAppPackageJson(config), null, 2)}\n`);
  writeFileSync(path.resolve(appPath, 'index.js'), `${buildStartScript(config)}\n`);
}
