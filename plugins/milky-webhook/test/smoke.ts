import { Context } from '@fraqjs/fraq';
import HonoPlugin from '@fraqjs/plugin-hono';
import { createSimpleLogHandler } from '@fraqjs/plugin-mock';

import MilkyWebhookPlugin from '../src';

const ctx = Context.fromUrl('http://localhost:30001/', {
  installEventSource: false,
  logHandler: createSimpleLogHandler(),
});

ctx.install(HonoPlugin);
ctx.install(MilkyWebhookPlugin);

ctx.router.command('test').execute(() => console.log('Test command executed'));

ctx.start();
