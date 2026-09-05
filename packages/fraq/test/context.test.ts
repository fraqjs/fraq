import { createMockContext, inmsg, inseg } from '@fraqjs/plugin-mock';

import { Context, definePlugin, filter, type milky, type RouteDescriptor } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

test('fork filters reject events without an explicit predicate', async () => {
  const ctx = createMockContext();
  const child = ctx.fork(
    'child',
    filter.define({
      message_receive: () => true,
    }),
  );
  let receivedRecallEvents = 0;

  child.on('message_recall', () => {
    receivedRecallEvents += 1;
  });

  await ctx.start();
  await ctx.mock.emitEvent({
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

test('plugin context registers routes with plugin metadata', async () => {
  const ctx = createMockContext();
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
  await ctx.mock.receiveFriend({ userId: 1 }, inmsg`hello`);
  await ctx.mock.receiveFriend({ userId: 1 }, inmsg`/hello`);
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
  const ctx = createMockContext({
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
  await ctx.mock.receiveFriend({ userId: 1 }, inmsg`ping`);
  await ctx.mock.receiveFriend({ userId: 1 }, inmsg`/ping`);
  await ctx.stop();

  assert.equal(calls, 1);
});

test('forked contexts inherit the activation resolver from their parent context', async () => {
  const ctx = createMockContext({
    routing: {
      activationResolver: () => [{ type: 'mention' }],
    },
  });
  const child = ctx.fork(
    'child',
    filter.define({
      message_receive: () => true,
    }),
  );
  let calls = 0;

  child.router.command('ping').execute(() => {
    calls += 1;
  });

  await ctx.start();
  await ctx.mock.receiveGroup({ groupId: 10, userId: 1 }, inmsg`ping`);
  await ctx.mock.receiveGroup({ groupId: 10, userId: 1 }, inmsg`${inseg.mention(10000)} ping`);
  await ctx.stop();

  assert.equal(calls, 1);
});

test('forked contexts receive filtered root events and call through the same base client', async () => {
  const ctx = createMockContext();
  const child = ctx.fork(
    'child',
    filter.define({
      message_receive: () => true,
    }),
  );
  let childMessageEvents = 0;

  child.on('message_receive', () => {
    childMessageEvents += 1;
  });

  await ctx.start();
  await ctx.mock.receiveFriend({ userId: 1 }, []);
  await child.client.get_friend_info({
    user_id: 1,
    no_cache: false,
  });

  assert.notEqual(child.client, ctx.client);
  assert.equal(ctx.mock.startEventCalls, 1);
  assert.equal(childMessageEvents, 1);
  assert.deepEqual(ctx.mock.apiCalls.at(-1), {
    endpoint: 'get_friend_info',
    params: {
      user_id: 1,
      no_cache: false,
    },
  });
});

test('session replies through the client API', async () => {
  const ctx = createMockContext();
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
  await ctx.mock.receiveGroup({ groupId: 123, userId: 456 }, inmsg`ping`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(ctx.mock.apiCalls, [
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

  assert.equal(ctx instanceof Context, true);
  assert.equal((ctx.client as unknown as { baseUrl: string }).baseUrl, 'http://localhost:30001');
});

test('session replies prepend quote and mention without mutating the supplied segments', async () => {
  const ctx = createMockContext();
  const message = await ctx.mock.receiveGroup({ groupId: 123, userId: 456 }, []);
  const segments: milky.OutgoingSegment_ZodInput[] = [{ type: 'text', data: { text: 'pong' } }];
  Object.freeze(segments);
  const session = ctx.createSession(10000, message);

  await session.reply(segments, { withQuote: true, withMention: true });
  await session.reply('hello');

  assert.deepEqual(segments, [{ type: 'text', data: { text: 'pong' } }]);
  assert.deepEqual(ctx.mock.apiCalls, [
    {
      endpoint: 'send_group_message',
      params: {
        group_id: 123,
        message: [
          { type: 'reply', data: { message_seq: message.message_seq } },
          { type: 'mention', data: { user_id: 456 } },
          ...segments,
        ],
      },
    },
    {
      endpoint: 'send_group_message',
      params: { group_id: 123, message: [{ type: 'text', data: { text: 'hello' } }] },
    },
  ]);
  await ctx.stop();
});
