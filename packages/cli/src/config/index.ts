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
