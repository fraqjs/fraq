import { createMockMilkyClient, inmsg, inseg } from '@fraqjs/mock';

import { Context, definePlugin, filter, type milky, type RouteDescriptor } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

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

test('forked contexts inherit the activation resolver from their parent context', async () => {
  const client = createMockMilkyClient();
  const parent = Context.fromClient(client, {
    routing: {
      activationResolver: () => [{ type: 'mention' }],
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

test('forked contexts receive filtered root events and call through the same base client', async () => {
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
  await child.client.get_friend_info({
    user_id: 1,
    no_cache: false,
  });

  assert.notEqual(child.client, parent.client);
  assert.equal(client.startEventCalls, 1);
  assert.equal(childMessageEvents, 1);
  assert.deepEqual(client.apiCalls.at(-1), {
    endpoint: 'get_friend_info',
    params: {
      user_id: 1,
      no_cache: false,
    },
  });
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

test('creates contexts from URLs with the default client', () => {
  const ctx = Context.fromUrl(new URL('http://localhost:30001/'), {
    accessToken: 'token',
  });

  assert.equal((ctx.client as unknown as { baseUrl: string }).baseUrl, 'http://localhost:30001');
});
