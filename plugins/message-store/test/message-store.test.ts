import type { Context, milky } from '@fraqjs/fraq';
import KyselyPlugin, { KyselyService } from '@fraqjs/plugin-kysely';
import { createMockContext, inmsg } from '@fraqjs/plugin-mock';

import MessageStorePlugin, { type MessageStorePluginOptions, MessageStoreService } from '../src';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function installMessageStore(ctx: Context, sqliteUrl = ':memory:', options?: MessageStorePluginOptions): void {
  ctx.install(KyselyPlugin, { sqliteUrl });
  ctx.install(MessageStorePlugin, options);
}

test('returns stored messages without calling the remote get_message API', async () => {
  const ctx = createMockContext();
  installMessageStore(ctx);
  await ctx.start();

  const received = await ctx.mock.receiveFriend({ userId: 10001 }, inmsg`stored`);
  await tick();
  ctx.mock.apiCalls.length = 0;

  const result = await ctx.client.get_message({
    message_scene: 'friend',
    peer_id: received.peer_id,
    message_seq: received.message_seq,
  });

  assert.deepEqual(result.message, received);
  assert.deepEqual(ctx.mock.apiCalls, []);
  await ctx.stop();
});

test('falls back to the remote get_message API before a received message has been stored', async () => {
  const ctx = createMockContext();
  installMessageStore(ctx);
  await ctx.start();

  const received = ctx.mock.inbox.friend({ userId: 10001 }, inmsg`remote`);
  const result = await ctx.client.get_message({
    message_scene: 'friend',
    peer_id: received.peer_id,
    message_seq: received.message_seq,
  });

  assert.deepEqual(result.message, received);
  assert.deepEqual(ctx.mock.apiCalls, [
    {
      endpoint: 'get_message',
      params: {
        message_scene: 'friend',
        peer_id: received.peer_id,
        message_seq: received.message_seq,
      },
    },
  ]);
  await ctx.stop();
});

test('returns a local history page in ascending sequence order', async () => {
  const ctx = createMockContext();
  installMessageStore(ctx);
  await ctx.start();

  const first = await ctx.mock.receiveGroup({ groupId: 20001, userId: 10001 }, inmsg`one`);
  const second = await ctx.mock.receiveGroup({ groupId: 20001, userId: 10002 }, inmsg`two`);
  const third = await ctx.mock.receiveGroup({ groupId: 20001, userId: 10003 }, inmsg`three`);
  await tick();
  ctx.mock.apiCalls.length = 0;

  const history = await ctx.client.get_history_messages({
    message_scene: 'group',
    peer_id: 20001,
    limit: 2,
  });

  assert.deepEqual(history, {
    messages: [second, third],
    next_message_seq: first.message_seq,
  });
  assert.deepEqual(ctx.mock.apiCalls, []);
  await ctx.stop();
});

test('falls back to the remote history API when no local messages match the query', async () => {
  const ctx = createMockContext();
  installMessageStore(ctx);
  await ctx.start();

  const received = ctx.mock.inbox.group({ groupId: 20001, userId: 10001 }, inmsg`remote`);
  const history = await ctx.client.get_history_messages({
    message_scene: 'group',
    peer_id: received.peer_id,
    limit: 30,
  });

  assert.deepEqual(history, {
    messages: [received],
    next_message_seq: undefined,
  });
  assert.deepEqual(ctx.mock.apiCalls, [
    {
      endpoint: 'get_history_messages',
      params: {
        message_scene: 'group',
        peer_id: received.peer_id,
        limit: 30,
      },
    },
  ]);
  await ctx.stop();
});

test('excludes recalled messages and falls back when the local result is empty', async () => {
  const ctx = createMockContext();
  installMessageStore(ctx);
  await ctx.start();

  const received = await ctx.mock.receiveFriend({ userId: 10001 }, inmsg`recalled`);
  await tick();
  await ctx.mock.emitEvent({
    event_type: 'message_recall',
    time: received.time + 1,
    self_id: 1,
    data: {
      message_scene: received.message_scene,
      peer_id: received.peer_id,
      message_seq: received.message_seq,
      sender_id: received.sender_id,
      operator_id: received.sender_id,
      display_suffix: '',
    },
  });
  await tick();
  ctx.mock.apiCalls.length = 0;

  const fromRemote = await ctx.client.get_message({
    message_scene: received.message_scene,
    peer_id: received.peer_id,
    message_seq: received.message_seq,
  });
  const history = await ctx.client.get_history_messages({
    message_scene: received.message_scene,
    peer_id: received.peer_id,
    limit: 30,
  });

  assert.deepEqual(fromRemote.message, received);
  assert.deepEqual(history, {
    messages: [received],
    next_message_seq: undefined,
  });
  assert.deepEqual(
    ctx.mock.apiCalls.map((call) => call.endpoint),
    ['get_message', 'get_history_messages'],
  );
  await ctx.stop();
});

test('does not intercept mark_message_as_read', async () => {
  const ctx = createMockContext();
  installMessageStore(ctx);
  await ctx.start();

  await ctx.client.mark_message_as_read({
    message_scene: 'friend',
    peer_id: 10001,
    message_seq: 1,
  });

  assert.deepEqual(ctx.mock.apiCalls, [
    {
      endpoint: 'mark_message_as_read',
      params: {
        message_scene: 'friend',
        peer_id: 10001,
        message_seq: 1,
      },
    },
  ]);
  await ctx.stop();
});

test('flushes expired records when the plugin starts', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'fraq-message-store-flush-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const sqliteUrl = join(tempDir, 'messages.sqlite');

  const firstCtx = createMockContext();
  installMessageStore(firstCtx, sqliteUrl, { autoFlush: { enabled: false } });
  await firstCtx.start();
  const received = await firstCtx.mock.receiveFriend({ userId: 10001 }, inmsg`expired`);
  await tick();
  await firstCtx
    .resolve(KyselyService)
    .db.updateTable('message_store_messages')
    .set({ stored_at: Date.now() - 1_000 })
    .execute();
  await firstCtx.stop();

  const secondCtx = createMockContext();
  installMessageStore(secondCtx, sqliteUrl, {
    autoFlush: { maxAgeDays: 0, intervalMinutes: 1 },
  });
  await secondCtx.start();

  const stored = await secondCtx.resolve(MessageStoreService).getMessage({
    message_scene: received.message_scene,
    peer_id: received.peer_id,
    message_seq: received.message_seq,
  });

  assert.equal(stored, undefined);
  await secondCtx.stop();
});

test('allows automatic expiration flushing to be disabled', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'fraq-message-store-no-flush-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const sqliteUrl = join(tempDir, 'messages.sqlite');
  const firstCtx = createMockContext();
  installMessageStore(firstCtx, sqliteUrl, { autoFlush: { enabled: false } });
  await firstCtx.start();

  const received = await firstCtx.mock.receiveFriend({ userId: 10001 }, inmsg`retained`);
  await tick();
  await firstCtx
    .resolve(KyselyService)
    .db.updateTable('message_store_messages')
    .set({ stored_at: Date.now() - 1_000 })
    .execute();
  await firstCtx.stop();

  const secondCtx = createMockContext();
  installMessageStore(secondCtx, sqliteUrl, { autoFlush: { enabled: false } });
  await secondCtx.start();

  const stored = await secondCtx.resolve(MessageStoreService).getMessage({
    message_scene: received.message_scene,
    peer_id: received.peer_id,
    message_seq: received.message_seq,
  });

  assert.deepEqual(stored, { message: received });
  await secondCtx.stop();
});

test('preserves stored messages across context restarts', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'fraq-message-store-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const sqliteUrl = join(tempDir, 'messages.sqlite');

  const firstCtx = createMockContext();
  installMessageStore(firstCtx, sqliteUrl);
  await firstCtx.start();
  const received = await firstCtx.mock.receiveTemp({ groupId: 20001, userId: 10001 }, inmsg`persistent`);
  await tick();
  await firstCtx.stop();

  const secondCtx = createMockContext();
  installMessageStore(secondCtx, sqliteUrl);
  await secondCtx.start();

  const result = await secondCtx.client.get_message({
    message_scene: received.message_scene,
    peer_id: received.peer_id,
    message_seq: received.message_seq,
  });
  const service = secondCtx.resolve(MessageStoreService);
  const directResult = await service.getMessage({
    message_scene: received.message_scene,
    peer_id: received.peer_id,
    message_seq: received.message_seq,
  });

  assert.deepEqual(result.message, received);
  assert.deepEqual(directResult, { message: received } satisfies milky.GetMessageOutput);
  assert.deepEqual(secondCtx.mock.apiCalls, []);
  await secondCtx.stop();
});
