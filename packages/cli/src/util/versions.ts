import YAML from 'yaml';

import type { ContextConfig } from '../config';
import { normalizePluginName } from './dependency';
import { getPackageJson } from './package-jsons';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function collectPluginNamesFromConfig(context: ContextConfig, pluginNames: Set<string>): void {
  for (const pluginName of Object.keys(context.plugins ?? {})) {
    pluginNames.add(pluginName);
  }
  for (const fork of Object.values(context.forks ?? {})) {
    collectPluginNamesFromConfig(fork, pluginNames);
  }
}

export function readVersions(): Record<string, string> {
  const versionsPath = path.resolve(process.cwd(), 'versions.yml');
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
  const pluginNames = new Set<string>();
  collectPluginNamesFromConfig(config, pluginNames);
  const missingPlugins = Array.from(pluginNames).filter((pluginName) => !versions[pluginName]);
  if (missingPlugins.length > 0) {
    return { status: 'missing', missingPlugins: missingPlugins.sort((a, b) => a.localeCompare(b)) };
  }
  return { status: 'ok' };
}

export async function completePluginVersions(
  config: ContextConfig,
  versions: Record<string, string>,
): Promise<Record<string, string>> {
  const pluginNames = new Set<string>();
  collectPluginNamesFromConfig(config, pluginNames);
  const completedVersions: Record<string, string> = {};

  for (const pluginName of pluginNames) {
    const version = versions[pluginName];
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
