import { PROTOCOL_VERSION } from '@fraqjs/cli-protocol';
import { defineCommonPlugin } from '@fraqjs/kernel';
import { WebuiGatewayService } from '@fraqjs/plugin-webui-gateway';

import { CliClient } from './cli';
import { CliIntegrationService } from './service';

export const CliIntegrationPlugin = defineCommonPlugin({
  name: 'cli-integration',
  inject: {
    webui: WebuiGatewayService,
  },
  provides: [CliIntegrationService],
  async apply(ctx) {
    const client = new CliClient();
    const service = new CliIntegrationService(client, (error) =>
      ctx.logger.error('CLI restart request failed.', error),
    );
    ctx.provide(CliIntegrationService, service);
    if (process.env.FRAQ_CLI_WATCH !== '1' || !process.send || !process.connected) {
      client.dispose();
      ctx.logger.info('CLI integration requires fraq start --watch; WebUI was not mounted.');
      return;
    }
    try {
      const hello = await client.request('hello', undefined);
      if (
        hello.version !== PROTOCOL_VERSION ||
        !['config', 'config-files', 'restart', 'logs'].every((value) => hello.capabilities.includes(value))
      ) {
        throw new Error('The CLI does not support this integration protocol.');
      }
    } catch (error) {
      client.dispose();
      ctx.logger.warn('CLI integration is unavailable; WebUI was not mounted.', error);
      return;
    }
    ctx.webui.mount({ assets: new URL('../dist/webui', import.meta.url), routes: (app) => service.routes(app) });
    ctx.logger.info('CLI WebUI registered at /webui/cli-integration/');
  },
});

export default CliIntegrationPlugin;
