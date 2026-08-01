import { definePlugin } from '@fraqjs/fraq';
import { HonoService } from '@fraqjs/plugin-hono';
import { cors } from 'hono/cors';

import { registerApiEndpoint } from './api-server';
import { EventBroadcaster, registerEventEndpoint } from './event-server';

export interface MilkyServerPluginOptions {
  accessToken?: string;
  prefix?: string;
}

export const MilkyServerPlugin = definePlugin({
  name: 'milky-server',
  inject: {
    hono: HonoService,
  },
  apply(ctx, options?: MilkyServerPluginOptions) {
    const accessToken = options?.accessToken;
    const prefix = normalizePrefix(options?.prefix ?? '/milky');
    const broadcaster = new EventBroadcaster();

    ctx.hono.app.use(`${prefix}/*`, cors());
    registerApiEndpoint(ctx, ctx.hono, prefix, accessToken);
    registerEventEndpoint(ctx, ctx.hono, broadcaster, prefix, accessToken);
  },
});

function normalizePrefix(prefix: string): string {
  const normalized = prefix.startsWith('/') ? prefix : `/${prefix}`;
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export default MilkyServerPlugin;
