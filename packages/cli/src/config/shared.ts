import z from 'zod';

import { existsSync } from 'node:fs';
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

export function getConfigPaths(): string[] {
  return ['fraq.yml', 'fraq.yaml', 'fraq.json'].map((candidate) => path.resolve(process.cwd(), candidate));
}

export function findConfigPath(): string {
  for (const configPath of getConfigPaths()) {
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  throw new Error('No configuration file found. Please create a fraq.yml, fraq.yaml, or fraq.json file.');
}
