import type { milky } from '@fraqjs/fraq';
import { createMockContext, createRandomFriend } from '@fraqjs/plugin-mock';

import { createResourceIndex, xmlify, xmlifyThread } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

const friend = createRandomFriend(10001);

function imageSegment(name: string): milky.IncomingSegment {
  return {
    type: 'image',
    data: {
      resource_id: name,
      temp_url: `https://example.com/${name}.png`,
      width: 100,
      height: 100,
      summary: '[图片]',
      sub_type: 'normal',
    },
  };
}

function friendMessage(seq: number, segments: milky.IncomingSegment[]): milky.IncomingMessage {
  return {
    message_scene: 'friend',
    peer_id: friend.user_id,
    message_seq: seq,
    sender_id: friend.user_id,
    time: 1_700_000_000 + seq,
    segments,
    friend,
  };
}

test('xmlify derives resource keys from the message seq', async () => {
  const ctx = createMockContext();
  const { xmlContent, resources } = await xmlify(
    ctx,
    friendMessage(7, [imageSegment('a'), { type: 'text', data: { text: 'hi' } }, imageSegment('b')]),
  );

  assert.deepEqual(resources, {
    'image-7-1': { url: 'https://example.com/a.png' },
    'image-7-2': { url: 'https://example.com/b.png' },
  });
  assert.match(xmlContent, /<image id="image-7-1"/);
  assert.match(xmlContent, /<image id="image-7-2"/);
});

test('xmlifyThread keeps a message rendering stable when the window slides', async () => {
  const ctx = createMockContext();
  const messages = [
    friendMessage(1, [imageSegment('a')]),
    friendMessage(2, [imageSegment('b')]),
    friendMessage(3, [imageSegment('c')]),
  ];

  const full = await xmlifyThread(ctx, messages);
  const slid = await xmlifyThread(ctx, messages.slice(1));

  assert.deepEqual(Object.keys(full.resources), ['image-1-1', 'image-2-1', 'image-3-1']);
  assert.deepEqual(Object.keys(slid.resources), ['image-2-1', 'image-3-1']);
  // The shared tail must serialize identically regardless of where the window starts.
  const tail = (xml: string) => xml.slice(xml.indexOf('<message seq="2"'));
  assert.equal(tail(slid.xmlContent), tail(full.xmlContent));
});

function forwardSegment(forwardId: string): milky.IncomingSegment {
  return { type: 'forward', data: { forward_id: forwardId, title: forwardId, preview: [], summary: '' } };
}

// seq 50: [image X, forward outer, image Y]
//   outer: [node: forward inner, image B], [node: image C]
//   inner: [node: image A]
function createForwardContext() {
  const ctx = createMockContext();
  const nodes: Record<string, milky.IncomingSegment[][]> = {
    outer: [[forwardSegment('inner'), imageSegment('B')], [imageSegment('C')]],
    inner: [[imageSegment('A')]],
  };
  ctx.hookApi('get_forwarded_messages', ({ forward_id }) => ({
    messages: nodes[forward_id].map((segments, index) => ({
      message_seq: index + 1,
      sender_name: 'Alice',
      avatar_url: '',
      time: 1_700_000_000,
      segments,
    })),
  }));
  const message = friendMessage(50, [imageSegment('X'), forwardSegment('outer'), imageSegment('Y')]);
  return { ctx, message };
}

function describeKeys(result: Awaited<ReturnType<typeof xmlify>>) {
  return {
    resources: Object.fromEntries(
      Object.entries(result.resources).map(([key, { url }]) => [key, url.replace(/^.*\/(\w+)\.png$/, '$1')]),
    ),
    forwards: Object.fromEntries(Object.entries(result.forwards).map(([key, data]) => [key, data.forward_id])),
  };
}

test('xmlify scopes resource keys by forward level', async () => {
  const { ctx, message } = createForwardContext();

  assert.deepEqual(describeKeys(await xmlify(ctx, message, { maxForwardDepth: 2 })), {
    resources: {
      'image-50-1': 'X',
      'image-50.1.1-1': 'A',
      'image-50.1-1': 'B',
      'image-50.1-2': 'C',
      'image-50-2': 'Y',
    },
    forwards: { 'forward-50-1': 'outer', 'forward-50.1-1': 'inner' },
  });
});

test('xmlify keys refer to the same resource at every maxForwardDepth', async () => {
  const { ctx, message } = createForwardContext();
  const merged: Record<string, string> = {};

  for (const maxForwardDepth of [0, 1, 2]) {
    const { resources, forwards } = describeKeys(await xmlify(ctx, message, { maxForwardDepth }));
    for (const [key, value] of Object.entries({ ...resources, ...forwards })) {
      assert.equal(merged[key] ?? value, value, `${key} changed meaning at maxForwardDepth=${maxForwardDepth}`);
      merged[key] = value;
    }
  }

  const shallow = await xmlify(ctx, message, { maxForwardDepth: 1 });
  assert.match(shallow.xmlContent, /<forward id="forward-50-1" depth="1" title="outer">/);
  assert.match(shallow.xmlContent, /<forward id="forward-50.1-1" title="inner">\(Too deeply nested\)<\/forward>/);
});

test('a message xmlified on its own shares keys with its thread rendering', async () => {
  const ctx = createMockContext();
  const focused = friendMessage(3, [imageSegment('c')]);
  const resourceIndex = createResourceIndex();

  const single = await xmlify(ctx, focused, { resourceIndex });
  const thread = await xmlifyThread(ctx, [friendMessage(2, [imageSegment('b')]), focused], { resourceIndex });

  assert.deepEqual(single.resources, { 'image-3-1': { url: 'https://example.com/c.png' } });
  assert.deepEqual(thread.resources['image-3-1'], single.resources['image-3-1']);
  assert.deepEqual(thread.resources['image-2-1'], { url: 'https://example.com/b.png' });
});
