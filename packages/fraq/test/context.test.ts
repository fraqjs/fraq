import { createMockMilkyClient, inmsg, inseg } from '@fraqjs/mock';

import { Context, definePlugin, filter, type LogMessage, type milky, type RouteDescriptor } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

function snapshotLog(message: LogMessage): Omit<LogMessage, 'time'> {
  const { time: _time, ...rest } = message;
  return rest;
}

test('fork filters reject events without an explicit predicate', async () => {
  const client = createMockMilkyClient();
  const parent = Context.fromClient(client);
  const child = parent.fork(
    'child',
    filter.define({
      message_receive: () => true,
    }),
  );
  let receivedRecallEvents = 0;

  child.on('message_recall', () => {
    receivedRecallEvents += 1;
  });

  await parent.start();
  await client.emitEvent({
    event_type: 'message_recall',
    time: 1,
    self_id: 1,
    data: {
      message_scene: 'friend',
      peer_id: 1,
      message_seq: 1,
      sender_id: 1,
      operator_id: 1,
      display_suffix: '',
    },
  });

  assert.equal(receivedRecallEvents, 0);
});

test('fork filters pass events when the predicate accepts them', async () => {
  const client = createMockMilkyClient();
  const parent = Context.fromClient(client);
  const child = parent.fork(
    'child',
    filter.define({
      message_receive: () => true,
    }),
  );
  let receivedMessageEvents = 0;

  child.on('message_receive', () => {
    receivedMessageEvents += 1;
  });

  await parent.start();
  await client.receiveFriend({ userId: 1 }, []);

  assert.equal(receivedMessageEvents, 1);
});

test('plugin context registers routes with plugin metadata', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client);
  const descriptors: RouteDescriptor[] = [];
  let calls = 0;

  ctx.router.setActivationResolver((route) => {
    descriptors.push(route);
    return route.meta?.plugin === 'meta-plugin' ? [{ type: 'prefix', prefix: '/' }] : [];
  });
  ctx.install(
    definePlugin({
      name: 'meta-plugin',
      apply(ctx) {
        ctx.router.command('hello').execute(() => {
          calls += 1;
        });
      },
    }),
  );

  await ctx.start();
  await client.receiveFriend({ userId: 1 }, inmsg`hello`);
  await client.receiveFriend({ userId: 1 }, inmsg`/hello`);
  await ctx.stop();

  assert.equal(calls, 1);
  assert.deepEqual(descriptors.at(-1), {
    type: 'command',
    path: [],
    name: 'hello',
    meta: { context: 'root', plugin: 'meta-plugin' },
  });
});

test('context routing activation applies scene-specific defaults', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client, {
    routing: {
      activation: {
        default: {
          friend: [{ type: 'direct' }],
          group: [{ type: 'mention' }],
        },
      },
    },
  });
  let calls = 0;

  ctx.router.command('ping').execute(() => {
    calls += 1;
  });

  await ctx.start();
  await client.receiveFriend({ userId: 1 }, inmsg`ping`);
  await client.receiveGroup({ groupId: 10, userId: 1 }, inmsg`ping`);
  await client.receiveGroup({ groupId: 10, userId: 1 }, inmsg`${inseg.mention(10000)} ping`);
  await ctx.stop();

  assert.equal(calls, 2);
});

test('context routing activation rules use singular activation field', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client, {
    routing: {
      activation: {
        default: [],
        rules: {
          match: { plugin: 'help' },
          activation: {
            friend: [{ type: 'prefix', prefix: '/' }],
          },
        },
      },
    },
  });
  let calls = 0;

  ctx.install(
    definePlugin({
      name: 'help',
      apply(ctx) {
        ctx.router.command('hello').execute(() => {
          calls += 1;
        });
      },
    }),
  );

  await ctx.start();
  await client.receiveFriend({ userId: 1 }, inmsg`hello`);
  await client.receiveFriend({ userId: 1 }, inmsg`/hello`);
  await ctx.stop();

  assert.equal(calls, 1);
});

test('context routing accepts a low-level activationResolver', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client, {
    routing: {
      activationResolver(route) {
        return route.type === 'command' && route.name === 'ping' ? [{ type: 'prefix', prefix: '/' }] : [];
      },
    },
  });
  let calls = 0;

  ctx.router.command('ping').execute(() => {
    calls += 1;
  });

  await ctx.start();
  await client.receiveFriend({ userId: 1 }, inmsg`ping`);
  await client.receiveFriend({ userId: 1 }, inmsg`/ping`);
  await ctx.stop();

  assert.equal(calls, 1);
});

test('forked contexts inherit context routing activation from their parent context', async () => {
  const client = createMockMilkyClient();
  const parent = Context.fromClient(client, {
    routing: {
      activation: {
        default: {
          group: [{ type: 'mention' }],
        },
      },
    },
  });
  const child = parent.fork(
    'child',
    filter.define({
      message_receive: () => true,
    }),
  );
  let calls = 0;

  child.router.command('ping').execute(() => {
    calls += 1;
  });

  await parent.start();
  await client.receiveGroup({ groupId: 10, userId: 1 }, inmsg`ping`);
  await client.receiveGroup({ groupId: 10, userId: 1 }, inmsg`${inseg.mention(10000)} ping`);
  await parent.stop();

  assert.equal(calls, 1);
});

test('context routing rejects activation config combined with activationResolver', () => {
  const client = createMockMilkyClient();

  assert.throws(
    () =>
      Context.fromClient(client, {
        routing: {
          activation: {},
          activationResolver: () => [],
        },
      }),
    /cannot specify both activation and activationResolver/,
  );
});

test('creates contexts from client instances and starts event streams on the root context', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client);
  let receivedMessageEvents = 0;

  ctx.on('message_receive', () => {
    receivedMessageEvents += 1;
  });

  await ctx.start();
  await client.receiveFriend({ userId: 1 }, []);

  assert.equal(ctx.client, client);
  assert.equal(client.startEventCalls, 1);
  assert.equal(receivedMessageEvents, 1);
});

test('forked contexts share the parent client and receive filtered root events', async () => {
  const client = createMockMilkyClient();
  const parent = Context.fromClient(client);
  const child = parent.fork(
    'child',
    filter.define({
      message_receive: () => true,
    }),
  );
  let childMessageEvents = 0;

  child.on('message_receive', () => {
    childMessageEvents += 1;
  });

  await parent.start();
  await client.receiveFriend({ userId: 1 }, []);

  assert.equal(child.client, client);
  assert.equal(client.startEventCalls, 1);
  assert.equal(childMessageEvents, 1);
});

test('session replies through the client API', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client);
  const replyMessage: milky.OutgoingSegment_ZodInput[] = [
    {
      type: 'text',
      data: {
        text: 'pong',
      },
    },
  ];

  ctx.router.command({
    name: 'ping',
    pattern: {},
    async execute(session) {
      await session.reply(replyMessage);
    },
  });

  await ctx.start();
  await client.receiveGroup({ groupId: 123, userId: 456 }, inmsg`ping`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(client.apiCalls, [
    {
      endpoint: 'send_group_message',
      params: {
        group_id: 123,
        message: replyMessage,
      },
    },
  ]);
});

test('retries the event stream after startup failures', async () => {
  const client = createMockMilkyClient();
  const logs: LogMessage[] = [];
  const startError = new Error('boom');
  const ctx = Context.fromClient(client, {
    reconnect: {
      initialDelayMs: 0,
      maxDelayMs: 0,
    },
    logHandler(message) {
      logs.push(message);
    },
  });
  client.failNextStart(startError);

  await ctx.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(client.startEventCalls, 2);
  assert.deepEqual(logs.map(snapshotLog), [
    {
      level: 'debug',
      module: 'context:root',
      message: 'Connecting event source (attempt=1)',
      error: undefined,
    },
    {
      level: 'error',
      module: 'context:root',
      message: 'Error connecting event source; reconnecting in 0ms',
      error: startError,
    },
    {
      level: 'debug',
      module: 'context:root',
      message: 'Connecting event source (attempt=2)',
      error: undefined,
    },
    {
      level: 'info',
      module: 'context:root',
      message: 'Event source connected',
      error: undefined,
    },
  ]);
});

test('creates contexts from URLs with the default client', () => {
  const ctx = Context.fromUrl(new URL('http://localhost:30001/'), {
    accessToken: 'token',
  });

  assert.equal((ctx.client as unknown as { baseUrl: string }).baseUrl, 'http://localhost:30001');
});

test('installs event sources explicitly', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client);
  const received: milky.Event[] = [];
  let resolveClosed!: () => void;
  let startCalls = 0;

  ctx.installEventSource({
    name: 'manual',
    async start(onEvent) {
      startCalls += 1;
      await onEvent({
        event_type: 'bot_offline',
        time: 1,
        self_id: 1,
        data: {
          reason: 'test',
        },
      });
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      return {
        closed,
        stop() {
          resolveClosed();
        },
      };
    },
  });

  ctx.on('bot_offline', (event) => {
    received.push(event);
  });

  await ctx.start();
  await ctx.stop();

  assert.equal(startCalls, 1);
  assert.equal(received.length, 1);
});

test('fromUrl installs the websocket event source by default and can opt out', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const urls: string[] = [];

  class FakeWebSocket {
    private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

    constructor(url: string) {
      urls.push(url);
      queueMicrotask(() => {
        this.emit('open', {});
      });
    }

    addEventListener(type: string, listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void {
      const listeners = this.listeners.get(type) ?? [];
      if (options?.once) {
        const onceListener = (event: { data?: unknown }) => {
          this.removeEventListener(type, onceListener);
          listener(event);
        };
        listeners.push(onceListener);
      } else {
        listeners.push(listener);
      }
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
      const listeners = this.listeners.get(type);
      if (!listeners) {
        return;
      }
      this.listeners.set(
        type,
        listeners.filter((current) => current !== listener),
      );
    }

    close(): void {
      this.emit('close', {});
    }

    private emit(type: string, event: { data?: unknown }): void {
      for (const listener of this.listeners.get(type) ?? []) {
        void listener(event);
      }
    }
  }

  // @ts-expect-error test-only WebSocket shim
  globalThis.WebSocket = FakeWebSocket;
  try {
    const withDefaultSource = Context.fromUrl(new URL('http://localhost:30001/'));
    const withoutSource = Context.fromUrl(new URL('http://localhost:30002/'), {
      installEventSource: false,
    });

    await withDefaultSource.start();
    await withDefaultSource.stop();
    await withoutSource.start();
    await withoutSource.stop();

    assert.deepEqual(urls, ['ws://localhost:30001/event']);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});
