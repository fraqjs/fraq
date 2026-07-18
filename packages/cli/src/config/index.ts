import { type ConfigV1, loadConfigV1 } from './v1';

export async function loadConfig(): Promise<Config> {
  return loadConfigV1();
}

export type Config = ConfigV1;
