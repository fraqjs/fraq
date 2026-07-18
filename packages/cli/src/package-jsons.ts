import { getPackageJsonCachePath } from './paths';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function writeCachedPackageJson(cacheFilePath: string, packageJson: unknown): void {
  mkdirSync(path.dirname(cacheFilePath), { recursive: true });
  writeFileSync(cacheFilePath, JSON.stringify(packageJson, null, 2), 'utf-8');
}

// biome-ignore lint/suspicious/noExplicitAny: package.json can have any structure, so we use `any` here
export async function getPackageJson(packageName: string, version: string): Promise<any> {
  if (version === 'latest') {
    return getLatestPackageJson(packageName);
  }
  const cacheFilePath = path.resolve(getPackageJsonCachePath(), `${packageName}@${version}.json`);

  if (existsSync(cacheFilePath)) {
    const cachedContent = readFileSync(cacheFilePath, 'utf-8');
    return JSON.parse(cachedContent);
  }

  const response = await fetch(`https://registry.npmjs.org/${packageName}/${version}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch package.json for ${packageName}@${version}: ${response.statusText}`);
  }
  const packageJson = await response.json();
  writeCachedPackageJson(cacheFilePath, packageJson);
  return packageJson;
}

// biome-ignore lint/suspicious/noExplicitAny: package.json can have any structure, so we use `any` here
export async function getLatestPackageJson(packageName: string): Promise<any> {
  const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
  if (!response.ok) {
    throw new Error(`Failed to fetch latest package.json for ${packageName}: ${response.statusText}`);
  }
  const packageJson = await response.json();
  const cacheFilePath = path.resolve(getPackageJsonCachePath(), `${packageName}@${packageJson.version}.json`);
  writeCachedPackageJson(cacheFilePath, packageJson);
  return packageJson;
}
