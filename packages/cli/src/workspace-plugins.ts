import type { DependencyConfig } from './config';
import type { FileAccessHandler } from './config/references';
import { findConfigPath } from './config/shared';
import { getAppPath } from './paths';

import { readFileSync } from 'node:fs';
import path from 'node:path';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.startsWith('./') ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = resolveExportTarget(item);
      if (target !== undefined) {
        return target;
      }
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const entries = Object.entries(value);
  const hasSubpathExports = entries.some(([condition]) => condition.startsWith('.'));
  const rootExport = hasSubpathExports ? entries.find(([condition]) => condition === '.')?.[1] : value;
  if (rootExport !== value) {
    return resolveExportTarget(rootExport);
  }
  for (const [condition, target] of entries) {
    if (condition === 'node' || condition === 'import' || condition === 'default') {
      const resolved = resolveExportTarget(target);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
  return undefined;
}

export function isWorkspacePlugin(config: Pick<DependencyConfig, 'workspacePlugins'>, pluginName: string): boolean {
  return config.workspacePlugins?.[pluginName] !== undefined;
}

export function getNpmPluginVersions(
  config: Pick<DependencyConfig, 'versions' | 'workspacePlugins'>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.versions).filter(([pluginName]) => !isWorkspacePlugin(config, pluginName)),
  );
}

export function resolveWorkspacePluginPath(
  config: Pick<DependencyConfig, 'workspacePlugins'>,
  pluginName: string,
): string | undefined {
  const configuredPath = config.workspacePlugins?.[pluginName];
  if (configuredPath === undefined) {
    return undefined;
  }
  return path.resolve(path.dirname(findConfigPath()), configuredPath);
}

export function getWorkspacePluginDependency(
  config: Pick<DependencyConfig, 'workspacePlugins'>,
  pluginName: string,
): string | undefined {
  const pluginPath = resolveWorkspacePluginPath(config, pluginName);
  if (pluginPath === undefined) {
    return undefined;
  }

  const relativePath = path.relative(getAppPath(), pluginPath).split(path.sep).join('/');
  return `file:${relativePath.startsWith('.') ? relativePath : `./${relativePath}`}`;
}

export function getWorkspacePluginPackageJson(
  config: Pick<DependencyConfig, 'workspacePlugins'>,
  pluginName: string,
  expectedPackageName: string,
  onFileAccess?: FileAccessHandler,
): Record<string, unknown> {
  const pluginPath = resolveWorkspacePluginPath(config, pluginName);
  if (pluginPath === undefined) {
    throw new Error(`Plugin "${pluginName}" is not configured as a workspace plugin.`);
  }

  const packageJsonPath = path.resolve(pluginPath, 'package.json');
  onFileAccess?.(packageJsonPath);

  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Failed to read package.json for workspace plugin "${pluginName}" at ${packageJsonPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (packageJson === null || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new Error(`Invalid package.json for workspace plugin "${pluginName}" at ${packageJsonPath}.`);
  }

  const packageName = 'name' in packageJson ? packageJson.name : undefined;
  if (packageName !== expectedPackageName) {
    throw new Error(
      `Workspace plugin "${pluginName}" must use package name "${expectedPackageName}", but ${packageJsonPath} declares ${JSON.stringify(packageName)}.`,
    );
  }

  return packageJson as Record<string, unknown>;
}

export function getWorkspacePluginEntryPoint(
  config: Pick<DependencyConfig, 'workspacePlugins'>,
  pluginName: string,
  expectedPackageName: string,
  onFileAccess?: FileAccessHandler,
): string {
  const pluginPath = resolveWorkspacePluginPath(config, pluginName);
  if (pluginPath === undefined) {
    throw new Error(`Plugin "${pluginName}" is not configured as a workspace plugin.`);
  }
  const packageJson = getWorkspacePluginPackageJson(config, pluginName, expectedPackageName, onFileAccess);
  const publishConfig =
    packageJson.publishConfig !== null &&
    typeof packageJson.publishConfig === 'object' &&
    !Array.isArray(packageJson.publishConfig)
      ? (packageJson.publishConfig as Record<string, unknown>)
      : undefined;

  const exportTarget = resolveExportTarget(publishConfig?.exports ?? packageJson.exports);
  const main = publishConfig?.main ?? packageJson.main;
  return path.resolve(pluginPath, exportTarget ?? (typeof main === 'string' ? main : 'index.js'));
}

export function getWorkspacePluginImportSpecifier(
  config: Pick<DependencyConfig, 'workspacePlugins'>,
  pluginName: string,
  expectedPackageName: string,
): string {
  const pluginPath = resolveWorkspacePluginPath(config, pluginName);
  if (pluginPath === undefined) {
    throw new Error(`Plugin "${pluginName}" is not configured as a workspace plugin.`);
  }
  const entryPoint = getWorkspacePluginEntryPoint(config, pluginName, expectedPackageName);
  const relativeEntryPoint = path.relative(pluginPath, entryPoint).split(path.sep).join('/');
  if (relativeEntryPoint.startsWith('../') || path.isAbsolute(relativeEntryPoint)) {
    throw new Error(`Workspace plugin "${pluginName}" declares an entry point outside its package directory.`);
  }
  return `./node_modules/${expectedPackageName}/${relativeEntryPoint}`;
}
