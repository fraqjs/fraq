import { definePlugin } from '@fraqjs/fraq';
import { HonoService } from '@fraqjs/plugin-hono';

import { WebuiGateway } from './gateway';
import { WebuiGatewayService, type WebuiGatewayServiceOptions } from './service';

export const WebuiGatewayPlugin = definePlugin({
  name: 'webui-gateway',
  inject: {
    hono: HonoService,
  },
  provides: [WebuiGatewayService],
  apply(ctx, options: WebuiGatewayServiceOptions) {
    const gateway = new WebuiGateway(ctx.hono, options);
    ctx.provide(WebuiGatewayService, (scope) => {
      const { plugin } = scope;
      if (!plugin) {
        throw new Error('WebuiGatewayService can only be resolved by a plugin.');
      }
      return new WebuiGatewayService((options) => gateway.mount(plugin, options));
    });
    ctx.logger.info('WebUI gateway registered at /webui');
  },
});

export * from './service';

export default WebuiGatewayPlugin;
