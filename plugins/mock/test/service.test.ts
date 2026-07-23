import type { AnyApiCall, milky } from '@fraqjs/fraq';

import { inmsg, MockInbox, MockService } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

function call<E extends keyof milky.ApiEndpoints>(endpoint: E, params: unknown): AnyApiCall {
  return { endpoint, params } as AnyApiCall;
}

test('handleApiCall records every call it receives', () => {
  const service = new MockService();

  service.handleApiCall(call('send_private_message', { user_id: 1, message: [] }));
  service.handleApiCall(call('send_group_message', { group_id: 2, message: [] }));

  assert.deepEqual(service.apiCalls, [
    { endpoint: 'send_private_message', params: { user_id: 1, message: [] } },
    { endpoint: 'send_group_message', params: { group_id: 2, message: [] } },
  ]);
});

test('handleApiCall answers read-side endpoints from the inbox', () => {
  const inbox = new MockInbox({ baseTime: 100 });
  const service = new MockService({ inbox });

  const first = inbox.group({ groupId: 20001, userId: 10001 }, inmsg`one`);
  const second = inbox.group({ groupId: 20001, userId: 10002 }, inmsg`two`);

  const one = service.handleApiCall(
    call('get_message', { message_scene: 'group', peer_id: 20001, message_seq: first.message_seq }),
  );
  const history = service.handleApiCall(
    call('get_history_messages', { message_scene: 'group', peer_id: 20001, limit: 1 }),
  );
  const groupInfo = service.handleApiCall(call('get_group_info', { group_id: 20001, no_cache: false }));
  const memberInfo = service.handleApiCall(
    call('get_group_member_info', { group_id: 20001, user_id: 10002, no_cache: false }),
  );

  assert.deepEqual(one, { message: first });
  assert.deepEqual(history, { messages: [second], next_message_seq: first.message_seq });
  assert.deepEqual(groupInfo, { group: second.group });
  assert.deepEqual(memberInfo, { member: second.group_member });
});

test('handleApiCall resolves unknown endpoints to an empty object', () => {
  const service = new MockService();

  const result = service.handleApiCall(call('send_private_message', { user_id: 1, message: [] }));

  assert.deepEqual(result, {});
});

test('reset clears recorded calls and inbox state', async () => {
  const service = new MockService();
  service.handleApiCall(call('send_private_message', { user_id: 1, message: [] }));
  await service.receiveFriend({ userId: 1 }, inmsg`hi`);

  service.reset();

  assert.deepEqual(service.apiCalls, []);
  assert.deepEqual(service.inbox.history(), []);
});

test('start delivers injected events and stop closes the subscription', async () => {
  const service = new MockService();
  const received: milky.Event[] = [];
  const subscription = await service.start((event) => {
    received.push(event);
  });

  await service.receiveFriend({ userId: 10001 }, inmsg`ping`);
  await subscription.stop();
  await subscription.closed;

  assert.equal(received.length, 1);
  assert.equal(received[0]?.event_type, 'message_receive');
  assert.equal(service.startEventCalls, 1);
});

test('failNextStart makes the next start throw once', async () => {
  const service = new MockService();
  const boom = new Error('boom');
  service.failNextStart(boom);

  await assert.rejects(() => service.start(() => {}), boom);
  // The failure is consumed; a subsequent start succeeds.
  const subscription = await service.start(() => {});
  await subscription.stop();
  assert.equal(service.startEventCalls, 2);
});

test('emitEvent is a no-op when no handler is subscribed', async () => {
  const service = new MockService();
  await service.emitEvent({ event_type: 'message_receive', time: 0, self_id: 1, data: {} } as milky.Event);
  // No throw, nothing recorded.
  assert.deepEqual(service.apiCalls, []);
});

test('receive helpers return the stored message', async () => {
  const service = new MockService();

  const friend = await service.receiveFriend({ userId: 10001 }, inmsg`hi`);
  const group = await service.receiveGroup({ groupId: 20001, userId: 10001 }, inmsg`yo`);
  const temp = await service.receiveTemp({ userId: 10001 }, inmsg`psst`);

  assert.equal(friend.message_scene, 'friend');
  assert.equal(group.message_scene, 'group');
  assert.equal(temp.message_scene, 'temp');
  assert.equal(service.inbox.history().length, 3);
});
