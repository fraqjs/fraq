import { Context, definePlugin, type milky, msg } from '@fraqjs/fraq';

import { createMockContext, inmsg, MockPlugin, MockService } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// A tiny plugin under test: replies "pong" to "ping".
const PingPlugin = definePlugin({
  name: 'ping',
  apply(ctx) {
    ctx.router.command('ping').execute(async (session) => {
      await session.reply(msg`pong`);
    });
  },
});

test('createMockContext exposes the mock before start and captures API calls', async () => {
  const ctx = createMockContext();
  assert.ok(ctx.mock instanceof MockService);

  ctx.install(PingPlugin);
  await ctx.start();

  await ctx.mock.receiveFriend({ userId: 1 }, inmsg`ping`);
  await tick();

  assert.deepEqual(ctx.mock.apiCalls, [
    {
      endpoint: 'send_private_message',
      params: {
        user_id: 1,
        message: msg`pong`,
      },
    },
  ]);

  await ctx.stop();
});

test('createMockContext forwards injected events to ctx.on subscribers', async () => {
  const ctx = createMockContext();
  const received: milky.IncomingMessage[] = [];
  ctx.on('message_receive', ({ data }) => {
    received.push(data);
  });
  await ctx.start();

  const message = await ctx.mock.receiveFriend({ userId: 10001 }, inmsg`ping`);
  await tick();

  assert.equal(received.length, 1);
  assert.equal(received[0], message);

  await ctx.stop();
});

test('createMockContext answers inbox read APIs through ctx.client', async () => {
  const ctx = createMockContext();
  await ctx.start();

  await ctx.mock.receiveGroup({ groupId: 20001, userId: 10002 }, inmsg`hello`);
  const info = await ctx.client.get_group_member_info({
    group_id: 20001,
    user_id: 10002,
    no_cache: false,
  });

  assert.equal(info.member.user_id, 10002);
  assert.equal(info.member.group_id, 20001);

  await ctx.stop();
});

test('a terminal ctx.hookApi stub overrides the response and bypasses the mock', async () => {
  const ctx = createMockContext();
  // Terminal hook (no next()): it fully replaces the mock for this endpoint,
  // so the call never reaches the mock and is not recorded in apiCalls.
  ctx.hookApi('send_private_message', () => ({ message_seq: 42, time: 100 }));

  let observedSeq: number | undefined;
  ctx.router.command('ping').execute(async (session) => {
    const { messageSeq } = await session.reply(msg`pong`);
    observedSeq = messageSeq;
  });
  await ctx.start();

  await ctx.mock.receiveFriend({ userId: 1 }, inmsg`ping`);
  await tick();

  assert.equal(observedSeq, 42);
  assert.deepEqual(ctx.mock.apiCalls, []);

  await ctx.stop();
});

test('a ctx.hookApi that calls next() lets the mock record the call', async () => {
  const ctx = createMockContext();
  ctx.hookApi('send_private_message', async (params, next) => {
    const result = await next(params);
    return { ...result, message_seq: 42 };
  });

  let observedSeq: number | undefined;
  ctx.router.command('ping').execute(async (session) => {
    const { messageSeq } = await session.reply(msg`pong`);
    observedSeq = messageSeq;
  });
  await ctx.start();

  await ctx.mock.receiveFriend({ userId: 1 }, inmsg`ping`);
  await tick();

  assert.equal(observedSeq, 42);
  assert.equal(ctx.mock.apiCalls.at(-1)?.endpoint, 'send_private_message');

  await ctx.stop();
});

test('MockPlugin provides a MockService resolvable by other plugins', async () => {
  const ctx = Context.fromClient({} as never);
  ctx.install(MockPlugin);
  ctx.install(PingPlugin);
  await ctx.start();

  const mock = ctx.resolve(MockService);
  await mock.receiveGroup({ groupId: 100, userId: 1 }, inmsg`ping`);
  await tick();

  assert.equal(mock.apiCalls.length, 1);
  assert.equal(mock.apiCalls[0]?.endpoint, 'send_group_message');

  await ctx.stop();
});

test('MockPlugin reuses a provided service instance', async () => {
  const service = new MockService();
  const ctx = Context.fromClient({} as never);
  ctx.install(MockPlugin, { service });
  await ctx.start();

  assert.equal(ctx.resolve(MockService), service);

  await ctx.stop();
});
