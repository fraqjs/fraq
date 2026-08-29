import { defineCommonPlugin } from '@fraqjs/kernel';

import { HonoService, type HonoServiceOptions } from './service';

export const HonoPlugin = defineCommonPlugin({
  name: 'hono',
  provides: [HonoService],
  apply(ctx, options?: HonoServiceOptions) {
    const service = new HonoService(options);
    ctx.provide(HonoService, service);
  },
  async start(ctx) {
    const service = ctx.resolve(HonoService);
    const info = await service.listen();
    ctx.logger.info(`Hono server is listening on ${info.address}:${info.port}`);
  },
});

export * from './service';

export default HonoPlugin;
