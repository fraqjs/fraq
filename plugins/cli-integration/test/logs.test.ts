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

test('SSE waits for each poll and cancels without scheduling more work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending: Array<ReturnType<typeof Promise.withResolvers<LogBatch>>> = [];
  let closed = 0;
  const client: ControlClient = {
    request: () => {
      const result = Promise.withResolvers<LogBatch>();
      pending.push(result);
      return result.promise as never;
    },
  };
  const stream = createLogStream(
    client,
    {},
    {
      expiresAt: Date.now() + 60_000,
      signal: new AbortController().signal,
      onClose: () => {
        closed++;
      },
      pollMs: 10,
    },
  );
  const reader = stream.body.getReader();
  t.after(() => reader.cancel());
  await Promise.resolve();
  assert.equal(pending.length, 1);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(pending.length, 1, 'an unfinished poll must prevent overlapping requests');
  pending[0].resolve({ session: 'session', entries: [entry(1)], cursor: 1, gap: false });
  assert.match(new TextDecoder().decode((await reader.read()).value), /id: session:1/);
  t.mock.timers.tick(10);
  await Promise.resolve();
  assert.equal(pending.length, 2);
  await reader.cancel();
  pending[1].resolve({ session: 'session', entries: [entry(2)], cursor: 2, gap: false });
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(pending.length, 2);
  assert.equal(closed, 1);
});

test('SSE bounds queued output and disconnects a reader that makes no progress', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
      expiresAt: Date.now() + 60_000,
      signal: new AbortController().signal,
      onClose: () => {
        closed = true;
      },
      pollMs: 1,
    },
  );
  t.after(() => stream.body.cancel());
  // Drive time without consuming: a bounded stream must close, regardless of its exact batch threshold.
  for (let index = 0; index < 32 && !closed; index++) {
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(1);
  }
  assert.equal(closed, true);
  assert.ok(calls > 0);
  const stoppedAt = calls;
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(calls, stoppedAt);
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
