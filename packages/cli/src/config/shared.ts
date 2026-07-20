import * as YAML from 'yaml';
import z from 'zod';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const RouteActivation = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('direct') }),
  z.strictObject({ type: z.literal('prefix'), prefix: z.string() }),
  z.strictObject({ type: z.literal('mention'), prefix: z.string().optional() }),
]);
export type RouteActivation = z.infer<typeof RouteActivation>;

export function zSingleOrArray<T>(schema: z.ZodType<T>): z.ZodType<T[]> {
  return z.union([schema, z.array(schema)]).transform((value) => (Array.isArray(value) ? value : [value]));
}

export function parseConfigFile(filePath: string): unknown {
  const configContent = readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.json')) {
    return JSON.parse(configContent);
  }
  return YAML.parse(configContent);
}

export function findConfigPath(): string {
  const configCandidates = ['fraq.yml', 'fraq.yaml', 'fraq.json'];
  for (const candidate of configCandidates) {
    const configPath = path.resolve(process.cwd(), candidate);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  throw new Error('No configuration file found. Please create a fraq.yml, fraq.yaml, or fraq.json file.');
}
