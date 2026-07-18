import * as YAML from 'yaml';

import { getPackageJson } from '../cache';
import { normalizePluginName } from '../dependency';
import { ConfigV1 } from './v1';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type ConfigDocument = Record<string, unknown>;

function isConfigDocument(value: unknown): value is ConfigDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfigFile(filePath: string): unknown {
  const configContent = readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.json')) {
    return JSON.parse(configContent);
  }
  return YAML.parse(configContent);
}

function findConfigPath(): string {
  const configCandidates = ['fraq.yml', 'fraq.yaml', 'fraq.json'];
  for (const candidate of configCandidates) {
    const configPath = path.resolve(process.cwd(), candidate);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  throw new Error('No configuration file found. Please create a fraq.yml, fraq.yaml, or fraq.json file.');
}

function readVersions(): Record<string, string> {
  const versionsPath = path.resolve(process.cwd(), 'versions.yml');
  if (!existsSync(versionsPath)) {
    return {};
  }

  const parsedVersions = parseConfigFile(versionsPath);
  if (!isConfigDocument(parsedVersions)) {
    throw new Error('Invalid versions.yml: expected a mapping of plugin names to versions.');
  }

  const versionsDocument = isConfigDocument(parsedVersions.versions) ? parsedVersions.versions : parsedVersions;
  const versions: Record<string, string> = {};
  for (const [name, version] of Object.entries(versionsDocument)) {
    if (typeof version !== 'string') {
      throw new Error(`Invalid version for ${name} in versions.yml: expected a string.`);
    }
    versions[name] = version;
  }
  return versions;
}

function collectPluginNames(context: ConfigDocument, pluginNames: Set<string>): void {
  if (isConfigDocument(context.plugins)) {
    for (const pluginName of Object.keys(context.plugins)) {
      pluginNames.add(pluginName);
    }
  }

  if (isConfigDocument(context.forks)) {
    for (const fork of Object.values(context.forks)) {
      if (isConfigDocument(fork)) {
        collectPluginNames(fork, pluginNames);
      }
    }
  }
}

async function completePluginVersions(config: ConfigDocument, versions: Record<string, string>): Promise<void> {
  const pluginNames = new Set<string>();
  collectPluginNames(config, pluginNames);

  for (const pluginName of pluginNames) {
    const version = versions[pluginName];
    if (typeof version === 'string' && version.trim().length > 0) {
      continue;
    }

    const packageName = normalizePluginName(pluginName);
    let packageJson: unknown;
    try {
      packageJson = await getPackageJson(packageName, 'latest');
    } catch (error) {
      const reason = error instanceof Error ? `: ${error.message}` : '';
      throw new Error(`Failed to resolve the latest version for plugin "${pluginName}"${reason}`, {
        cause: error,
      });
    }

    if (!isConfigDocument(packageJson) || typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
      throw new Error(`Package metadata for plugin "${pluginName}" does not contain a valid version.`);
    }
    versions[pluginName] = packageJson.version;
  }
}

function saveVersions(versions: Record<string, string>): void {
  const versionsPath = path.resolve(process.cwd(), 'versions.yml');
  writeFileSync(versionsPath, YAML.stringify(versions), 'utf-8');
}

export async function loadConfig(): Promise<Config> {
  const configPath = findConfigPath();
  const rawConfig = parseConfigFile(configPath);
  if (!isConfigDocument(rawConfig)) {
    throw new Error(`Invalid configuration file: expected a mapping in ${path.basename(configPath)}.`);
  }

  const parsedConfig = ConfigV1.parse(rawConfig);
  const versions = {
    ...readVersions(),
    ...parsedConfig.versions,
  };
  await completePluginVersions(rawConfig, versions);

  const mergedConfig = ConfigV1.parse({
    ...rawConfig,
    versions,
  });
  saveVersions(versions);
  return mergedConfig;
}

export type Config = ConfigV1;
