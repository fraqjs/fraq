import { definePlugin, type milky } from '@fraqjs/fraq';
import { HonoService } from '@fraqjs/plugin-hono';

export interface MilkyWebhookPluginOptions {
  endpoint?: string;
  accessToken?: string;
}

export const MilkyWebhookPlugin = definePlugin({
  name: 'milky-webhook',
  inject: {
    hono: HonoService,
  },
  apply(ctx, options?: MilkyWebhookPluginOptions) {
    const endpoint = options?.endpoint || '/milky/webhook';
    const accessToken = options?.accessToken;
    let onEvent: ((event: milky.Event) => void | Promise<void>) | undefined;
    let closedResolve: (() => void) | undefined;

    ctx.hono.app.post(endpoint, async (c) => {
      if (accessToken) {
        const token = c.req.header('Authorization')?.replace('Bearer ', '');
        if (token !== accessToken) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
      }
      const payload = await c.req.json();
      onEvent?.(payload);
      return c.json({ status: 'success' });
    });
    ctx.logger.info(`Milky Webhook plugin registered at ${endpoint}`);

    ctx.installEventSource({
      name: 'webhook',
      start: async (eventHandler) => {
        onEvent = eventHandler;
        return {
          closed: new Promise<void>((resolve) => {
            closedResolve = resolve;
          }),
          stop: () => {
            onEvent = undefined;
            closedResolve?.();
          },
        };
      },
    });
  },
});

export default MilkyWebhookPlugin;
