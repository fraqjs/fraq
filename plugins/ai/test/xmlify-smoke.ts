import { Context } from '@fraqjs/fraq';
import { createSimpleLogHandler } from '@fraqjs/plugin-mock';

import { xmlify } from '../src';

const ctx = Context.fromUrl('http://localhost:30001', {
  logHandler: createSimpleLogHandler(),
});

ctx.on('message_receive', async ({ data }) => {
  console.log(
    'Received message:',
    (
      await xmlify(ctx, data, {
        maxForwardDepth: 1,
      })
    ).xmlContent,
  );
});

ctx.start();

process.on('SIGINT', async () => {
  await ctx.stop();
  process.exit(0);
});
