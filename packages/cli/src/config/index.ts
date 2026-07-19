import * as v1 from './v1';

export type FilterConfig = v1.FilterConfigV1;
export type ContextConfig = v1.ContextConfigV1;
export type ActivationConfig = v1.ActivationConfigV1;
export type Config = v1.ConfigV1;

export async function loadConfig(): Promise<Config> {
  return v1.loadConfigV1();
}
