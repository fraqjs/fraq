import { definePlugin } from '@fraqjs/fraq';
import { HonoService } from '@fraqjs/plugin-hono';

import { WebuiGatewayService, type WebuiGatewayServiceOptions } from './service';

export const WebuiGatewayPlugin = definePlugin({
  name: 'webui-gateway',
  inject: {
    hono: HonoService,
  },
  provides: [WebuiGatewayService],
  apply(ctx, options: WebuiGatewayServiceOptions) {
    const service = new WebuiGatewayService(ctx.hono, options);
    ctx.provide(WebuiGatewayService, service);
    ctx.logger.info('WebUI gateway registered at /webui');
  },
});

export * from './service';

export default WebuiGatewayPlugin;
