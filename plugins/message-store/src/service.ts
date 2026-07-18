import type { milky } from '@fraqjs/fraq';
import type { KyselyService } from '@fraqjs/plugin-kysely';

const MESSAGE_STORE_TABLE = 'message_store_messages';

type MessageIdentity = Pick<milky.GetMessageInput_ZodInput, 'message_scene' | 'peer_id' | 'message_seq'>;

declare module '@fraqjs/plugin-kysely' {
  interface FraqDatabase {
    message_store_messages: {
      message_scene: 'friend' | 'group' | 'temp';
      peer_id: number;
      message_seq: number;
      sender_id: number | null;
      message_time: number | null;
      self_id: number | null;
      payload_json: string | null;
      stored_at: number;
      recalled_at: number | null;
      recall_json: string | null;
    };
  }
}

export interface MessageStoreServiceOptions {
  autoFlush?: {
    enabled?: boolean;
    intervalMinutes?: number;
    maxAgeDays?: number;
  };
}

export class MessageStoreService {
  constructor(
    private readonly kysely: KyselyService,
    readonly options?: MessageStoreServiceOptions,
  ) {
    kysely.schemas.register({
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
  }

  async storeReceived(selfId: number, message: milky.IncomingMessage): Promise<void> {
    await this.kysely.db
      .insertInto(MESSAGE_STORE_TABLE)
      .values({
        message_scene: message.message_scene,
        peer_id: message.peer_id,
        message_seq: message.message_seq,
        sender_id: message.sender_id,
        message_time: message.time,
        self_id: selfId,
        payload_json: JSON.stringify(message),
        stored_at: Date.now(),
        recalled_at: null,
        recall_json: null,
      })
      .onConflict((conflict) =>
        conflict.columns(['message_scene', 'peer_id', 'message_seq']).doUpdateSet({
          sender_id: message.sender_id,
          message_time: message.time,
          self_id: selfId,
          payload_json: JSON.stringify(message),
          stored_at: Date.now(),
        }),
      )
      .execute();
  }

  async storeRecall(event: milky.MessageRecallEvent): Promise<void> {
    const { data } = event;
    await this.kysely.db
      .insertInto(MESSAGE_STORE_TABLE)
      .values({
        message_scene: data.message_scene,
        peer_id: data.peer_id,
        message_seq: data.message_seq,
        sender_id: data.sender_id,
        message_time: null,
        self_id: event.self_id,
        payload_json: null,
        stored_at: Date.now(),
        recalled_at: event.time,
        recall_json: JSON.stringify(event),
      })
      .onConflict((conflict) =>
        conflict.columns(['message_scene', 'peer_id', 'message_seq']).doUpdateSet({
          recalled_at: event.time,
          recall_json: JSON.stringify(event),
        }),
      )
      .execute();
  }

  async getMessage(identity: MessageIdentity): Promise<milky.GetMessageOutput | undefined> {
    const row = await this.kysely.db
      .selectFrom(MESSAGE_STORE_TABLE)
      .where('message_scene', '=', identity.message_scene)
      .where('peer_id', '=', identity.peer_id)
      .where('message_seq', '=', identity.message_seq)
      .where('recalled_at', 'is', null)
      .select('payload_json')
      .executeTakeFirst();
    if (!row?.payload_json) {
      return undefined;
    }
    return { message: JSON.parse(row.payload_json) };
  }

  async getHistory(
    params: milky.GetHistoryMessagesInput_ZodInput,
  ): Promise<milky.GetHistoryMessagesOutput | undefined> {
    const limit = params.limit ?? 30;
    if (limit > 30) {
      throw new RangeError('limit must be less than or equal to 30.');
    }

    let query = this.kysely.db
      .selectFrom(MESSAGE_STORE_TABLE)
      .select(['message_seq', 'payload_json'])
      .where('message_scene', '=', params.message_scene)
      .where('peer_id', '=', params.peer_id)
      .where('recalled_at', 'is', null)
      .where('payload_json', 'is not', null);
    if (params.start_message_seq != null) {
      query = query.where('message_seq', '<=', params.start_message_seq);
    }

    const rows = await query
      .orderBy('message_seq', 'desc')
      .limit(limit + 1)
      .execute();
    if (rows.length === 0) {
      return undefined;
    }

    const pageRows = rows.slice(0, limit);
    return {
      messages: pageRows.toReversed().flatMap((row) => (row.payload_json ? [JSON.parse(row.payload_json)] : [])),
      next_message_seq: rows[limit]?.message_seq,
    };
  }

  async flushExpired(maxAgeMs: number): Promise<number> {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new RangeError('maxAgeMs must be a non-negative finite number.');
    }

    const result = await this.kysely.db
      .deleteFrom(MESSAGE_STORE_TABLE)
      .where('stored_at', '<', Date.now() - maxAgeMs)
      .executeTakeFirstOrThrow();
    return Number(result.numDeletedRows);
  }
}
