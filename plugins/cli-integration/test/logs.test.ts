import { type ControlClient, type LogBatch, type LogEntry, MAX_LOG_BYTES, MAX_LOG_LINES } from '@fraqjs/cli-protocol';

import { createLogStream } from '../src/logs';
import { mergeLogs } from '../webui/src/logs';

import assert from 'node:assert/strict';
import test from 'node:test';

function entry(sequence: number, bytes = 1): LogEntry {
  return {
    session: 'session',
    sequence,
    time: 1,
    source: 'app',
    stream: 'stdout',
    text: 'a'.repeat(bytes),
    bytes,
    truncated: false,
  };
}

test('browser log retention deduplicates replay, caps memory and replaces a previous session', () => {
  const batch = (entries: LogEntry[]): LogBatch => ({
    entries,
    session: 'session',
    cursor: entries.at(-1)?.sequence ?? 0,
    gap: false,
  });
  const first = mergeLogs([], batch([entry(1), entry(2)]));
  assert.deepEqual(
    mergeLogs(first, batch([entry(2), entry(3)])).map((line) => line.sequence),
    [1, 2, 3],
  );
  assert.equal(mergeLogs([], batch(Array.from({ length: 1100 }, (_, index) => entry(index)))).length, MAX_LOG_LINES);
  const large = mergeLogs([], batch(Array.from({ length: 300 }, (_, index) => entry(index, 16 * 1024))));
  assert.ok(large.reduce((bytes, line) => bytes + line.bytes, 0) <= MAX_LOG_BYTES);
  assert.equal(mergeLogs(first, { ...batch([]), session: 'new' }).length, 0);
});

test('SSE polls sequentially and releases its subscription on cancellation', async () => {
  let calls = 0;
  let closed = false;
  const client: ControlClient = {
    request: async () => {
      calls++;
      return { session: 'session', entries: [entry(calls)], cursor: calls, gap: false } as never;
    },
  };
  const stream = createLogStream(
    client,
    {},
    {
      expiresAt: Date.now() + 1000,
      signal: new AbortController().signal,
      onClose: () => {
        closed = true;
      },
      pollMs: 10,
    },
  );
  const reader = stream.body.getReader();
  const frame = await reader.read();
  assert.match(new TextDecoder().decode(frame.value), /id: session:1/);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(closed, true);
});

test('SSE disconnects a slow reader instead of accumulating queued log batches', async () => {
  let calls = 0;
  let closed = false;
  const client: ControlClient = {
    request: async () => {
      calls++;
      return { session: 'session', entries: [entry(calls, MAX_LOG_BYTES)], cursor: calls, gap: false } as never;
    },
  };
  const stream = createLogStream(
    client,
    {},
    {
      expiresAt: Date.now() + 1000,
      signal: new AbortController().signal,
      onClose: () => {
        closed = true;
      },
      pollMs: 1,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(closed, true);
  assert.equal(calls, 2);
  await stream.body.cancel();
});

test('SSE ends an expired session without requesting logs', async () => {
  const client: ControlClient = {
    request: async () => {
      throw new Error('must not be called');
    },
  };
  const stream = createLogStream(
    client,
    {},
    { expiresAt: Date.now() - 1, signal: new AbortController().signal, onClose() {} },
  );
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: auth/);
  assert.equal((await reader.read()).done, true);
});
