import * as v1 from './v1';

export type FilterConfig = v1.FilterConfigV1;
export type ContextConfig = v1.ContextConfigV1;
export type ActivationConfig = v1.ActivationConfigV1;
export type Config = v1.ConfigV1;
export type DependencyConfig = v1.DependencyConfigV1;

export async function loadConfig(options: { resolveAllReferences: true }): Promise<Config>;
export async function loadConfig(options?: { resolveAllReferences?: false }): Promise<DependencyConfig>;
export async function loadConfig(options: { resolveAllReferences?: boolean } = {}): Promise<Config | DependencyConfig> {
  return options.resolveAllReferences ? v1.loadConfigV1({ resolveAllReferences: true }) : v1.loadConfigV1();
}
