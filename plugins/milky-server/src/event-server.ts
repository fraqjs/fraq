import type { Context, EventMap, milky } from '@fraqjs/fraq';
import type { HonoService } from '@fraqjs/plugin-hono';
import { streamSSE } from 'hono/streaming';

const EVENT_TYPES = [
  'bot_offline',
  'message_receive',
  'message_recall',
  'peer_pin_change',
  'friend_request',
  'group_join_request',
  'group_invited_join_request',
  'group_invitation',
  'friend_nudge',
  'friend_file_upload',
  'group_admin_change',
  'group_essence_message_change',
  'group_member_increase',
  'group_member_decrease',
  'group_disband',
  'group_name_change',
  'group_message_reaction',
  'group_mute',
  'group_whole_mute',
  'group_nudge',
  'group_file_upload',
] as const satisfies readonly (keyof EventMap)[];

type EventSender = (event: milky.Event) => void;

export class EventBroadcaster {
  private readonly senders = new Set<EventSender>();

  subscribe(sender: EventSender): () => void {
    this.senders.add(sender);
    return () => {
      this.senders.delete(sender);
    };
  }

  broadcast(event: milky.Event): void {
    for (const sender of this.senders) {
      try {
        sender(event);
      } catch {
        // sender failed; it will be cleaned up by its own lifecycle handler
      }
    }
  }

  close(): void {
    this.senders.clear();
  }
}

export function registerEventEndpoint(
  ctx: Context,
  hono: HonoService,
  broadcaster: EventBroadcaster,
  prefix: string,
  accessToken?: string,
): void {
  for (const type of EVENT_TYPES) {
    ctx.on(type, (event) => broadcaster.broadcast(event));
  }

  hono.app.get(
    `${prefix}/event`,
    async (c, next) => {
      if (accessToken) {
        const token = c.req.header('Authorization')?.replace('Bearer ', '') ?? c.req.query('access_token');
        if (token !== accessToken) {
          return c.json({ status: 'failed', retcode: -401, message: 'Unauthorized' }, 401);
        }
      }
      return next();
    },
    hono.upgradeWebSocket(() => {
      let unsubscribe: (() => void) | undefined;
      return {
        onOpen(_evt, ws) {
          unsubscribe = broadcaster.subscribe((event) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify(event));
            }
          });
        },
        onClose() {
          unsubscribe?.();
        },
      };
    }),
    (c) =>
      streamSSE(c, async (stream) => {
        const unsubscribe = broadcaster.subscribe((event) => {
          if (stream.aborted) return;
          stream.writeSSE({ event: 'milky_event', data: JSON.stringify(event) }).catch(() => unsubscribe());
        });
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            unsubscribe();
            resolve();
          });
        });
      }),
  );

  ctx.logger.info(`Milky event endpoint registered at ${prefix}/event (SSE + WebSocket)`);
}
