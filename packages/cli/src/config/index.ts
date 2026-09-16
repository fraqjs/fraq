import { bindCliPluginVersions, checkVersionsCompleteness, checkVersionsConsistency, readVersions } from '../versions';
import type { FileAccessHandler } from './references';
import * as v1 from './v1';

export type FilterConfig = v1.FilterConfigV1;
export type ContextConfig = v1.ContextConfigV1;
export type ActivationConfig = v1.ActivationConfigV1;
export type Config = v1.ConfigV1;
export type DependencyConfig = v1.DependencyConfigV1;

interface LoadConfigOptions {
  resolveAllReferences?: boolean;
  onFileAccess?: FileAccessHandler;
  throwOnValidationError?: boolean;
}

export async function loadConfig(options: LoadConfigOptions & { resolveAllReferences: true }): Promise<Config>;
export async function loadConfig(
  options?: LoadConfigOptions & { resolveAllReferences?: false },
): Promise<DependencyConfig>;
export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config | DependencyConfig> {
  return options.resolveAllReferences
    ? v1.loadConfigV1({ ...options, resolveAllReferences: true })
    : v1.loadConfigV1({ ...options, resolveAllReferences: false });
}

export async function loadProjectConfig(options: LoadConfigOptions & { resolveAllReferences: true }): Promise<Config>;
export async function loadProjectConfig(
  options?: LoadConfigOptions & { resolveAllReferences?: false },
): Promise<DependencyConfig>;
export async function loadProjectConfig(options: LoadConfigOptions = {}): Promise<Config | DependencyConfig> {
  const config = options.resolveAllReferences
    ? await loadConfig({ ...options, resolveAllReferences: true, throwOnValidationError: true })
    : await loadConfig({ ...options, resolveAllReferences: false, throwOnValidationError: true });
  const locked = bindCliPluginVersions(config, readVersions());
  config.versions = bindCliPluginVersions(config, { ...locked, ...config.versions });
  const completeness = checkVersionsCompleteness(config, config.versions);
  if (completeness.status === 'missing') {
    throw new Error(
      `The following plugin versions are missing:\n${completeness.missingPlugins.map((name) => `- ${name}`).join('\n')}\nRun fraq lock to complete plugin versions.`,
    );
  }
  const consistency = checkVersionsConsistency(
    config.versions,
    locked,
    new Set(Object.keys(config.workspacePlugins ?? {})),
  );
  if (consistency.status === 'inconsistent') {
    throw new Error(
      `The following plugin versions are inconsistent with the lockfile:\n${consistency.inconsistentPlugins.map((plugin) => `- ${plugin.name}: configured ${plugin.configured}, lockfile ${plugin.lockfile}`).join('\n')}\nRun fraq lock to sync the lockfile.`,
    );
  }
  return config;
}
