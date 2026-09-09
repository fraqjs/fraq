import type { IncomingSegment } from '../src/protocol/types';
import { Tokenizer } from '../src/routing/tokenizer';

import assert from 'node:assert/strict';
import test from 'node:test';

const text = (value: string) => ({ type: 'text' as const, data: { text: value } });
const mention = { type: 'mention' as const, data: { user_id: 42, name: 'alice' } };

test('exact text consumption agrees with peek and next, including cursor state', () => {
  const whitespace = [' ', '\t', '\n', '\r', '\v', '\f', '\u00A0', '\u3000'];
  const values = ['', 'ping', 'pingpong', 'ping tail', 'ping\u2003tail', 'ping\uFEFFtail', '你好', '😀'];
  const inputs: IncomingSegment[][] = [
    [],
    [mention],
    [text('pin'), text('g')],
    [text(''), text('  '), text('ping'), mention],
    ...values.map((value) => [text(value)]),
    ...whitespace.map((space) => [text(`${space}ping${space}tail${space}`)]),
  ];
  const candidates = [...values, ...whitespace.map((space) => `ping${space}tail`)];

  for (const segments of inputs) {
    for (const candidate of candidates) {
      const expected = new Tokenizer(segments);
      const actual = new Tokenizer(segments);
      const matches = expected.peek() === candidate;
      if (matches) expected.next();

      assert.equal(actual.consumeTextToken(candidate), matches);
      assert.deepEqual(actual.getState(), expected.getState());
      assert.deepEqual(actual.next(), expected.next());
    }
  }
});

test('exact text consumption works after prefix consumption and state restoration', () => {
  const tokenizer = new Tokenizer([text('  /admin ping  '), mention]);
  assert.equal(tokenizer.consumeTextPrefix('/'), true);
  const start = tokenizer.getState();
  assert.equal(tokenizer.consumeTextToken('ad'), false);
  assert.equal(tokenizer.consumeTextToken('admin ping'), false);
  assert.deepEqual(tokenizer.getState(), start);
  assert.equal(tokenizer.consumeTextToken('admin'), true);
  assert.equal(tokenizer.consumeTextToken('ping'), true);
  assert.equal(tokenizer.next(), mention);
  tokenizer.setState(start);
  assert.equal(tokenizer.consumeTextToken('admin'), true);
  assert.equal(tokenizer.greedy(), 'ping  ');
});

test('greedy skips empty text segments, preserves trailing whitespace and stops at the segment boundary', () => {
  const tokenizer = new Tokenizer([text(''), text(' \t'), text('  hello  '), text('world'), mention]);
  const start = tokenizer.getState();
  assert.equal(tokenizer.isGreedyAvailable(), true);
  assert.deepEqual(tokenizer.getState(), start);
  assert.equal(tokenizer.greedy(), 'hello  ');
  assert.equal(tokenizer.greedy(), 'world');
  assert.equal(tokenizer.isGreedyAvailable(), false);
  const beforeMention = tokenizer.getState();
  assert.throws(() => tokenizer.greedy(), /Greedy token is not available/);
  assert.deepEqual(tokenizer.getState(), beforeMention);
  assert.equal(tokenizer.next(), mention);
  assert.equal(tokenizer.isGreedyAvailable(), false);
});

test('catch-all clones only the first text segment and retains subsequent segment references', () => {
  const first = { ...text('  hello  '), marker: 'segment', data: { text: '  hello  ', marker: 'data' } };
  const empty = text('');
  const trailing = text('  ');
  const segments = [text(''), text(' '), first, mention, empty, trailing];
  const tokenizer = new Tokenizer(segments);
  const result = tokenizer.catchAll();

  assert.deepEqual(result, [{ ...first, data: { ...first.data, text: 'hello  ' } }, mention, empty, trailing]);
  assert.notEqual(result[0], first);
  assert.notEqual(result[0].data, first.data);
  assert.equal(result[1], mention);
  assert.equal(result[2], empty);
  assert.equal(result[3], trailing);
  assert.equal(first.data.text, '  hello  ');
  assert.deepEqual(tokenizer.getState(), { offset: segments.length, subOffset: undefined });
  assert.equal(tokenizer.hasNext(), false);
});

test('catch-all starting at a non-text segment returns a new array with the original segments', () => {
  const segments = [mention, text('  ')];
  const result = new Tokenizer(segments).catchAll();
  assert.notEqual(result, segments);
  assert.equal(result[0], segments[0]);
  assert.equal(result[1], segments[1]);
});

test('unavailable catch-all does not advance the cursor', () => {
  const tokenizer = new Tokenizer([text(''), text('  ')]);
  const start = tokenizer.getState();
  assert.equal(tokenizer.isCatchAllAvailable(), false);
  assert.throws(() => tokenizer.catchAll(), /Catch-all token is not available/);
  assert.deepEqual(tokenizer.getState(), start);
});
