import { definePlugin } from '@fraqjs/fraq';
import { KyselyService } from '@fraqjs/plugin-kysely';

import { MessageStoreService, type MessageStoreServiceOptions } from './service';

const DEFAULT_AUTO_FLUSH_INTERVAL_MINUTES = 60;
const DEFAULT_AUTO_FLUSH_MAX_AGE_DAYS = 30;

export interface MessageStorePluginOptions extends MessageStoreServiceOptions {
  listenRecall?: boolean;
}

export const MessageStorePlugin = definePlugin({
  name: 'message-store',
  inject: {
    kysely: KyselyService,
  },
  provides: [MessageStoreService],
  apply(ctx, options?: MessageStorePluginOptions) {
    const listenRecall = options?.listenRecall ?? true;

    const store = new MessageStoreService(ctx.kysely, options);
    ctx.provide(MessageStoreService, store);

    ctx.on('message_receive', ({ self_id, data }) => store.storeReceived(self_id, data));
    if (listenRecall) {
      ctx.on('message_recall', (event) => store.storeRecall(event));
    }

    ctx.hookApi('get_message', async (params, next) => {
      const local = await store.getMessage(params);
      return local ?? (await next(params));
    });
    ctx.hookApi('get_history_messages', async (params, next) => {
      const local = await store.getHistory(params);
      return local ?? (await next(params));
    });
  },
  async start(ctx) {
    const store = ctx.resolve(MessageStoreService);
    const autoFlush = store.options?.autoFlush;
    if (!autoFlush) {
      return;
    }

    const autoFlushMaxAgeMs = (autoFlush.maxAgeDays ?? DEFAULT_AUTO_FLUSH_MAX_AGE_DAYS) * 24 * 60 * 60 * 1_000;
    const autoFlushIntervalMs = (autoFlush.intervalMinutes ?? DEFAULT_AUTO_FLUSH_INTERVAL_MINUTES) * 60 * 1_000;

    const flush = async () => {
      const deleted = await store.flushExpired(autoFlushMaxAgeMs);
      if (deleted > 0) {
        ctx.logger.debug(`Flushed ${deleted} expired message store record(s).`);
      }
    };
    await flush();
    ctx.interval(autoFlushIntervalMs, flush);
  },
});

export * from './service';

export default MessageStorePlugin;
