import chalk from 'chalk';
import z from 'zod';

import { findConfigPath, parseConfigFile, RouteActivation, zSingleOrArray } from './shared';

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

export const RouteActivationInputV1: z.ZodType<RouteActivation> = z
  .union([z.enum(['direct', 'mention']), RouteActivation])
  .transform((value) => {
    if (typeof value === 'string') {
      if (value === 'direct') {
        return { type: 'direct' };
      }
      if (value === 'mention') {
        return { type: 'mention' };
      }
    }
    return value;
  });

export const ActivationConfigV1 = z.strictObject({
  default: zSingleOrArray(RouteActivationInputV1).optional(),
  overrides: z
    .array(
      z.strictObject({
        match: z.strictObject({
          plugin: zSingleOrArray(z.string()).optional(),
          context: zSingleOrArray(z.string()).optional(),
          tag: zSingleOrArray(z.string()).optional(),
          command: zSingleOrArray(z.string()).optional(),
        }),
        rule: zSingleOrArray(RouteActivationInputV1),
      }),
    )
    .optional(),
});
export type ActivationConfigV1 = z.infer<typeof ActivationConfigV1>;

export const ActivationConfigInputV1: z.ZodType<ActivationConfigV1> = z
  .union([RouteActivationInputV1, z.array(RouteActivationInputV1), ActivationConfigV1])
  .transform((value) => {
    if (Array.isArray(value)) {
      return { default: value };
    }
    if ('type' in value) {
      return { default: [value] };
    }
    return value;
  });

export const ConfigV1 = ContextConfigV1.extend({
  configVersion: z.literal(1),
  packageManager: z.enum(['npm', 'pnpm', 'yarn']).optional(),
  fraqVersion: z.string(),
  milky: z.object({
    url: z.url(),
    accessToken: z.string().optional(),
    connectEvent: z.boolean().default(true),
  }),
  activation: ActivationConfigInputV1.optional(),
  logging: z
    .object({
      minLevel: z.enum(['debug', 'info', 'warn', 'error']),
    })
    .default({ minLevel: 'debug' }),
  versions: z.record(z.string(), z.string()).default({}),
  additionalDependencies: z.record(z.string(), z.string()).optional(),
});
export type ConfigV1 = z.infer<typeof ConfigV1>;

export function loadConfigV1(): ConfigV1 {
  const configPath = findConfigPath();
  const rawConfig = parseConfigFile(configPath);

  const configParseResult = ConfigV1.safeParse(rawConfig);
  if (configParseResult.error) {
    console.log(chalk.red('There are issues with your configuration file:'));
    console.log(chalk.red(z.prettifyError(configParseResult.error)));
    process.exit(1);
  }
  const parsedConfig = configParseResult.data;

  return parsedConfig;
}
