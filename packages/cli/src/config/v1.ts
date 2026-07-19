import * as YAML from 'yaml';
import z from 'zod';

import { normalizePluginName } from '../dependency';
import { getPackageJson } from '../package-jsons';
import { findConfigPath, parseConfigFile, readVersions } from './shared';

import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const FilterConfigV1 = z.union([
  z.enum(['allPass', 'allFriends', 'allGroups', 'admin']),
  z.object({ friends: z.array(z.number()) }),
  z.object({ groups: z.array(z.number()) }),
  z.object({
    get or() {
      return z.array(FilterConfigV1);
    },
  }),
  z.object({
    get and() {
      return z.array(FilterConfigV1);
    },
  }),
  z.object({
    get not() {
      return FilterConfigV1;
    },
  }),
]);
export type FilterConfigV1 = z.infer<typeof FilterConfigV1>;

export const ContextConfigV1 = z.object({
  plugins: z.record(z.string(), z.any()).optional(),
  get forks() {
    return z.record(z.string(), ContextConfigV1.extend({ filter: FilterConfigV1.optional() })).optional();
  },
});
export type ContextConfigV1 = z.infer<typeof ContextConfigV1>;

export const ConfigV1 = ContextConfigV1.extend({
  configVersion: z.literal(1),
  packageManager: z.enum(['npm', 'pnpm', 'yarn']).optional(),
  fraqVersion: z.string(),
  milky: z.object({
    url: z.url(),
    accessToken: z.string().optional(),
    connectEvent: z.boolean().default(true),
  }),
  routing: z.any().optional(),
  logging: z
    .object({
      minLevel: z.enum(['debug', 'info', 'warn', 'error']),
    })
    .default({ minLevel: 'debug' }),
  versions: z.record(z.string(), z.string()).default({}),
  additionalDependencies: z.record(z.string(), z.string()).optional(),
});
export type ConfigV1 = z.infer<typeof ConfigV1>;

function collectPluginNames(context: ContextConfigV1, pluginNames: Set<string>): void {
  for (const pluginName of Object.keys(context.plugins ?? {})) {
    pluginNames.add(pluginName);
  }
  for (const fork of Object.values(context.forks ?? {})) {
    collectPluginNames(fork, pluginNames);
  }
}

async function completePluginVersions(config: ConfigV1, versions: Record<string, string>): Promise<void> {
  const pluginNames = new Set<string>();
  collectPluginNames(config, pluginNames);

  for (const pluginName of Object.keys(versions)) {
    if (!pluginNames.has(pluginName)) {
      delete versions[pluginName];
    }
  }

  for (const pluginName of pluginNames) {
    const version = versions[pluginName];
    if (typeof version === 'string' && version.trim().length > 0) {
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
    versions[pluginName] = packageJson.version;
  }
}

export async function loadConfigV1(): Promise<ConfigV1> {
  const configPath = findConfigPath();
  const rawConfig = parseConfigFile(configPath);

  const parsedConfig = ConfigV1.parse(rawConfig);
  const versions = {
    ...readVersions(),
    ...parsedConfig.versions,
  };
  await completePluginVersions(parsedConfig, versions);
  const orderedVersions = Object.fromEntries(
    Object.entries(versions).sort(([left], [right]) => left.localeCompare(right)),
  );

  const mergedConfig = ConfigV1.parse({
    ...parsedConfig,
    versions: orderedVersions,
  });
  writeFileSync(path.resolve(process.cwd(), 'versions.yml'), YAML.stringify(orderedVersions), 'utf-8');
  return mergedConfig;
}
