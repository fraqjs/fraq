import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function getAppPath(): string {
  return path.resolve(process.cwd(), 'app');
}

export function getCachePath(): string {
  return path.resolve(process.cwd(), 'cache');
}

export function getVersionsPath(): string {
  return path.resolve(process.cwd(), 'versions.yml');
}

export function getPackageJsonCachePath(): string {
  return path.resolve(getCachePath(), 'package-json');
}

export function ensureAppPaths(): void {
  mkdirSync(getAppPath(), { recursive: true });
}
