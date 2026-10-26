import { createRandomFriend, createRandomGroup, createRandomGroupMember } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

test('random friends are deterministic for the same user id', () => {
  const first = createRandomFriend(10001);
  const second = createRandomFriend(10001);

  assert.deepEqual(first, second);
});

test('random friends preserve distinct user identities and reproducible profiles', () => {
  const first = createRandomFriend(10001);
  const second = createRandomFriend(10002);

  assert.deepEqual(first, createRandomFriend(10001));
  assert.deepEqual(second, createRandomFriend(10002));
  assert.equal(first.user_id, 10001);
  assert.equal(second.user_id, 10002);
});

test('random friends support top-level and nested overrides', () => {
  const friend = createRandomFriend(10001, {
    remark: 'Pinned contact',
    category: {
      category_name: 'VIP',
    },
  });

  assert.equal(friend.user_id, 10001);
  assert.equal(friend.remark, 'Pinned contact');
  assert.equal(friend.category.category_name, 'VIP');
  assert.equal(typeof friend.category.category_id, 'number');
});

test('random groups are deterministic and internally consistent', () => {
  const first = createRandomGroup(20001);
  const second = createRandomGroup(20001);

  assert.deepEqual(first, second);
  assert.equal(first.group_id, 20001);
  assert.equal(first.member_count <= first.max_member_count, true);
  assert.equal(first.created_time > 0, true);
});

test('random group members reuse stable user profile fields', () => {
  const friend = createRandomFriend(10001);
  const member = createRandomGroupMember(20001, 10001);

  assert.equal(member.user_id, friend.user_id);
  assert.equal(member.nickname, friend.nickname);
  assert.equal(member.sex, friend.sex);
  assert.equal(member.group_id, 20001);
  assert.equal(member.join_time <= member.last_sent_time, true);
});

test('entity factories reject unsafe integer seeds', () => {
  assert.throws(() => createRandomFriend(Number.MAX_SAFE_INTEGER + 1), RangeError);
  assert.throws(() => createRandomGroup(1.5), RangeError);
  assert.throws(() => createRandomGroupMember(20001, Number.NaN), RangeError);
});
