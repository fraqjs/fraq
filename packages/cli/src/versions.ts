import YAML, { type Document } from 'yaml';

import type { ContextConfig } from './config';
import { collectPluginNames } from './config/context';
import { findConfigPath } from './config/shared';
import { normalizePluginName } from './dependency';
import { getLatestPackageJson, getPackageJson } from './package-jsons';
import { getVersionsPath } from './paths';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function readVersionDocument(filePath: string): Document {
  const document = YAML.parseDocument(existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '{}\n');
  if (document.errors.length > 0) {
    throw new Error(`Failed to parse ${filePath}: ${document.errors[0]?.message}`);
  }
  return document;
}

function setVersionInDocument(document: Document, path: string[], version: string): void {
  const currentVersion = document.getIn(path, true);
  if (YAML.isScalar(currentVersion)) {
    currentVersion.value = version;
  } else {
    document.setIn(path, version);
  }
}

export function readVersions(): Record<string, string> {
  const versionsPath = getVersionsPath();
  if (!existsSync(versionsPath)) {
    return {};
  }
  const parsedVersions = YAML.parse(readFileSync(versionsPath, 'utf-8'));
  const versions: Record<string, string> = {};
  for (const [name, version] of Object.entries(parsedVersions ?? {})) {
    if (typeof version !== 'string') {
      throw new Error(`Invalid version for ${name} in versions.yml: expected a string.`);
    }
    versions[name] = version;
  }
  return versions;
}

export type VersionsCompleteness = { status: 'ok' } | { status: 'missing'; missingPlugins: string[] };

export function checkVersionsCompleteness(
  config: ContextConfig,
  versions: Record<string, string>,
): VersionsCompleteness {
  const pluginNames = collectPluginNames(config);
  const missingPlugins = Array.from(pluginNames).filter((pluginName) => !versions[pluginName]);
  if (missingPlugins.length > 0) {
    return { status: 'missing', missingPlugins: missingPlugins.sort((a, b) => a.localeCompare(b)) };
  }
  return { status: 'ok' };
}

export type VersionsConsistency =
  | { status: 'ok' }
  | {
      status: 'inconsistent';
      inconsistentPlugins: {
        name: string;
        configured: string;
        lockfile: string;
      }[];
    };

export function checkVersionsConsistency(
  configuredVersions: Record<string, string>,
  lockfileVersions: Record<string, string>,
): VersionsConsistency {
  const inconsistentPlugins: Array<{
    name: string;
    configured: string;
    lockfile: string;
  }> = [];
  for (const [name, configuredVersion] of Object.entries(configuredVersions)) {
    const lockfileVersion = lockfileVersions[name];
    if (lockfileVersion && lockfileVersion !== configuredVersion) {
      inconsistentPlugins.push({ name, configured: configuredVersion, lockfile: lockfileVersion });
    }
  }
  if (inconsistentPlugins.length > 0) {
    return {
      status: 'inconsistent',
      inconsistentPlugins: inconsistentPlugins.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return { status: 'ok' };
}

export interface OutdatedVersionsCheckResult {
  outdated: Array<{ type: 'fraq' | 'plugin'; name: string; current: string; latest: string }>;
  errors: Array<{ type: 'fraq' | 'plugin'; name: string; error: unknown }>;
}

export async function checkOutdatedVersions(
  fraqVersion: string,
  pluginVersions: Record<string, string>,
): Promise<OutdatedVersionsCheckResult> {
  const outdated: OutdatedVersionsCheckResult['outdated'] = [];
  const errors: OutdatedVersionsCheckResult['errors'] = [];

  await Promise.all(
    [
      { type: 'fraq' as const, name: 'Fraq', packageName: '@fraqjs/fraq', currentVersion: fraqVersion },
      ...Object.entries(pluginVersions).map(([name, currentVersion]) => ({
        type: 'plugin' as const,
        name,
        packageName: normalizePluginName(name),
        currentVersion,
      })),
    ].map(async ({ type, name, packageName, currentVersion }) => {
      try {
        const latestPackageJson = await getLatestPackageJson(packageName);
        const latestVersion = latestPackageJson.version;
        if (latestVersion && latestVersion !== currentVersion) {
          outdated.push({ type, name, current: currentVersion, latest: latestVersion });
        }
      } catch (error) {
        errors.push({ type, name, error });
      }
    }),
  );

  return {
    outdated: outdated.sort((a, b) => a.name.localeCompare(b.name)),
    errors: errors.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function applyVersionUpdates(updates: {
  fraqVersion?: string;
  pluginVersions?: Record<string, string>;
}): string[] {
  const configPath = findConfigPath();
  const configDocument = readVersionDocument(configPath);
  const pluginVersions = Object.entries(updates.pluginVersions ?? {});
  const configVersions = configDocument.get('versions', true);
  if (pluginVersions.length > 0 && YAML.isScalar(configVersions)) {
    throw new Error(
      `Cannot update plugin versions because "versions" in ${configPath} is declared through a reference.`,
    );
  }

  const versionsPath = getVersionsPath();
  const versionsDocument = readVersionDocument(versionsPath);
  let configChanged = false;
  let versionsChanged = false;

  if (updates.fraqVersion !== undefined) {
    setVersionInDocument(configDocument, ['fraqVersion'], updates.fraqVersion);
    configChanged = true;
  }

  for (const [name, version] of pluginVersions) {
    const configVersionPath = ['versions', name];
    const declaredInConfig = configDocument.hasIn(configVersionPath);
    const declaredInLockfile = versionsDocument.has(name);
    if (!declaredInConfig && !declaredInLockfile) {
      throw new Error(`Cannot find a version declaration for plugin "${name}".`);
    }
    if (declaredInConfig) {
      setVersionInDocument(configDocument, configVersionPath, version);
      configChanged = true;
    }
    if (declaredInLockfile) {
      setVersionInDocument(versionsDocument, [name], version);
      versionsChanged = true;
    }
  }

  const changedFiles: string[] = [];
  if (configChanged) {
    writeFileSync(configPath, configDocument.toString(), 'utf-8');
    changedFiles.push(configPath);
  }
  if (versionsChanged) {
    writeFileSync(versionsPath, versionsDocument.toString(), 'utf-8');
    changedFiles.push(versionsPath);
  }
  return changedFiles;
}

export async function completeAndSyncVersions(
  config: ContextConfig,
  lockfileVersions: Record<string, string>,
): Promise<Record<string, string>> {
  const pluginNames = collectPluginNames(config);
  const completedVersions: Record<string, string> = {};

  for (const pluginName of pluginNames) {
    const version = lockfileVersions[pluginName];
    if (typeof version === 'string' && version.trim().length > 0) {
      completedVersions[pluginName] = version;
      continue;
    }

    const packageName = normalizePluginName(pluginName);
    // biome-ignore lint/suspicious/noExplicitAny: PackageJson type is not defined, so we use any here
    let packageJson: any;
    try {
      packageJson = await getPackageJson(packageName, 'latest');
    } catch (error) {
      const reason = error instanceof Error ? `: ${error.message}` : '';
      throw new Error(`Failed to resolve the latest version for plugin "${pluginName}"${reason}`, {
        cause: error,
      });
    }

    if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
      throw new Error(`Package metadata for plugin "${pluginName}" does not contain a valid version.`);
    }
    completedVersions[pluginName] = packageJson.version;
  }

  return Object.fromEntries(Object.entries(completedVersions).sort(([left], [right]) => left.localeCompare(right)));
}
