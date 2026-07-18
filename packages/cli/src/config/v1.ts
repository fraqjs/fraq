import z from 'zod';

export const ContextConfig = z.object({
  plugins: z.record(z.string(), z.any()).optional(),
  get forks() {
    return z.record(z.string(), ContextConfig).optional();
  },
});
export type ContextConfig = z.infer<typeof ContextConfig>;

export const ConfigV1 = ContextConfig.extend({
  configVersion: z.literal(1),
  packageManager: z.enum(['npm', 'pnpm', 'yarn']).optional(),
  fraqVersion: z.string(),
  milky: z.object({
    url: z.url(),
    accessToken: z.string().optional(),
    connectEvent: z.boolean().default(true),
  }),
  logging: z
    .object({
      minLevel: z.enum(['debug', 'info', 'warn', 'error']),
    })
    .default({ minLevel: 'debug' }),
  versions: z.record(z.string(), z.string()).default({}),
  additionalDependencies: z.record(z.string(), z.string()).optional(),
});
export type ConfigV1 = z.infer<typeof ConfigV1>;
