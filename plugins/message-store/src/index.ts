import { definePlugin, type milky } from '@fraqjs/fraq';
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

    async function refreshTempUrlRKey(payload: milky.IncomingMessage[]) {
      const rkeyByAppId = new Map<string, string>();

      for (const msg of payload) {
        for (const segment of msg.segments) {
          if ('temp_url' in segment.data) {
            const queryParams = new URL(segment.data.temp_url).searchParams;
            const appId = queryParams.get('appid');
            if (!appId) {
              continue;
            }
            const newRkey = rkeyByAppId.get(appId);
            if (!newRkey) {
              try {
                const { url: newDownloadUrl } = await ctx.client.get_resource_temp_url({
                  resource_id: segment.data.resource_id,
                });
                const newQueryParams = new URL(newDownloadUrl).searchParams;
                const newRkey = newQueryParams.get('rkey');
                if (newRkey) {
                  rkeyByAppId.set(appId, newRkey);
                }
                segment.data.temp_url = newDownloadUrl;
              } catch (error) {
                ctx.logger.warn('Failed to refresh temp_url rkey for segment', error);
                // continue;
              }
            } else {
              const url = new URL(segment.data.temp_url);
              url.searchParams.set('rkey', newRkey);
              segment.data.temp_url = url.toString();
            }
          }
        }
      }
    }

    ctx.hookApi('get_message', async (params, next) => {
      const local = await store.getMessage(params);
      if (local) {
        await refreshTempUrlRKey([local.message]);
        return local;
      }
      return await next(params);
    });
    ctx.hookApi('get_history_messages', async (params, next) => {
      const local = await store.getHistory(params);
      if (local) {
        await refreshTempUrlRKey(local.messages);
        return local;
      }
      return await next(params);
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
