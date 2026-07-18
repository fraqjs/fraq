import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const appPath = path.resolve(process.cwd(), 'app');
const cachePath = path.resolve(process.cwd(), 'cache');
const packageJsonCachePath = path.resolve(cachePath, 'package-json');

if (!existsSync(appPath)) {
  mkdirSync(appPath, { recursive: true });
}

if (!existsSync(cachePath)) {
  mkdirSync(cachePath, { recursive: true });
}

if (!existsSync(packageJsonCachePath)) {
  mkdirSync(packageJsonCachePath, { recursive: true });
}

export { appPath, cachePath, packageJsonCachePath };
