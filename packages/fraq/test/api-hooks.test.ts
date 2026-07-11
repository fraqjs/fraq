import { createMockMilkyClient } from '@fraqjs/mock';

import { Context, type milky } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

function createFriendInfo(userId: number, nickname: string): milky.GetFriendInfoOutput {
  return {
    friend: {
      user_id: userId,
      nickname,
      sex: 'unknown',
      qid: `qid_${userId}`,
      remark: '',
      category: {
        category_id: 1,
        category_name: 'General',
      },
    },
  };
}

test('hookApi can override calls through the context client', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client);

  ctx.hookApi('get_friend_info', (params) => createFriendInfo(params.user_id, 'Hooked'));

  const result = await ctx.client.get_friend_info({
    user_id: 10001,
    no_cache: false,
  });

  assert.equal(result.friend.nickname, 'Hooked');
  assert.deepEqual(client.apiCalls, []);
});

test('hookApi can call the next API handler with updated params', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client);

  ctx.hookApi('get_friend_info', async (params, next) => {
    return await next({
      ...params,
      user_id: 10002,
    });
  });

  const result = await ctx.client.get_friend_info({
    user_id: 10001,
    no_cache: false,
  });

  assert.equal(result.friend.user_id, 10002);
  assert.deepEqual(client.apiCalls, [
    {
      endpoint: 'get_friend_info',
      params: {
        user_id: 10002,
        no_cache: false,
      },
    },
  ]);
});

test('parent context API hooks are visible to forked contexts', async () => {
  const client = createMockMilkyClient();
  const parent = Context.fromClient(client);
  const child = parent.fork('child');

  parent.hookApi('get_friend_info', (params) => createFriendInfo(params.user_id, 'Parent'));

  const result = await child.client.get_friend_info({
    user_id: 10001,
    no_cache: false,
  });

  assert.equal(result.friend.nickname, 'Parent');
  assert.deepEqual(client.apiCalls, []);
});

test('child context API hooks run before parent context API hooks', async () => {
  const client = createMockMilkyClient();
  const parent = Context.fromClient(client);
  const child = parent.fork('child');
  const calls: string[] = [];

  parent.hookApi('get_friend_info', async (params, next) => {
    calls.push('parent');
    const result = await next(params);
    return {
      friend: {
        ...result.friend,
        nickname: `parent:${result.friend.nickname}`,
      },
    };
  });
  child.hookApi('get_friend_info', async (params, next) => {
    calls.push('child');
    const result = await next(params);
    return {
      friend: {
        ...result.friend,
        nickname: `child:${result.friend.nickname}`,
      },
    };
  });

  const result = await child.client.get_friend_info({
    user_id: 10001,
    no_cache: false,
  });

  assert.deepEqual(calls, ['child', 'parent']);
  assert.match(result.friend.nickname, /^child:parent:/);
});
