import { definePlugin } from '@fraqjs/fraq';
import { KyselyService } from '@fraqjs/plugin-kysely';

import { MessageStoreService } from './service';

export interface MessageStorePluginOptions {
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

    ctx.kysely.schemas.register({
      name: 'message-store',
      migrations: {
        '001_create_message_store_messages': {
          async up(db) {
            await db.schema
              .createTable('message_store_messages')
              .addColumn('message_scene', 'text', (column) => column.notNull())
              .addColumn('peer_id', 'integer', (column) => column.notNull())
              .addColumn('message_seq', 'integer', (column) => column.notNull())
              .addColumn('sender_id', 'integer')
              .addColumn('message_time', 'integer')
              .addColumn('self_id', 'integer')
              .addColumn('payload_json', 'text')
              .addColumn('stored_at', 'integer', (column) => column.notNull())
              .addColumn('recalled_at', 'integer')
              .addColumn('recall_json', 'text')
              .addPrimaryKeyConstraint('message_store_messages_pk', ['message_scene', 'peer_id', 'message_seq'])
              .execute();

            await db.schema
              .createIndex('message_store_messages_history_idx')
              .on('message_store_messages')
              .columns(['message_scene', 'peer_id', 'recalled_at', 'message_seq'])
              .execute();
          },
        },
      },
    });
    const store = new MessageStoreService(ctx.kysely);
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
});

export * from './service';

export default MessageStorePlugin;
