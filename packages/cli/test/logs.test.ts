import { MAX_LOG_BYTES, MAX_LOG_LINE_BYTES, MAX_LOG_LINES } from '@fraqjs/cli-protocol';

import { LogRegistry } from '../src/app/logs';

import assert from 'node:assert/strict';
import { finished } from 'node:stream/promises';
import test from 'node:test';

test('decodes UTF-8 chunks, CRLF, ANSI and unterminated output per stream', async () => {
  const logs = new LogRegistry();
  const stdout = logs.output('app', 'stdout');
  const text = Buffer.from('\u001b[32m你好\u001b[0m\r\nsecond\rlast');
  for (const byte of text) stdout.write(Buffer.from([byte]));
  stdout.end();
  await finished(stdout);
  const stderr = logs.output('install', 'stderr');
  stderr.end('error');
  await finished(stderr);
  const entries = logs.read().entries;
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ['你好', 'second', 'last', 'error'],
  );
  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    [1, 2, 3, 4],
  );
  assert.equal(entries[3]?.source, 'install');
  assert.equal(entries[3]?.stream, 'stderr');
});

test('caps individual lines, total bytes and replay cursors', async () => {
  const logs = new LogRegistry();
  const stdout = logs.output('app', 'stdout');
  stdout.write('界'.repeat(MAX_LOG_LINE_BYTES));
  stdout.write('\n');
  assert.equal(logs.read().entries[0]?.truncated, true);
  assert.ok((logs.read().entries[0]?.bytes ?? Infinity) <= MAX_LOG_LINE_BYTES);
  const cursor = logs.read().cursor;
  for (let index = 0; index < 400; index++) stdout.write(`${'x'.repeat(MAX_LOG_LINE_BYTES)}\n`);
  const batch = logs.read({ session: logs.session, after: cursor });
  assert.equal(batch.gap, true);
  assert.ok(batch.entries.reduce((sum, entry) => sum + entry.bytes, 0) <= MAX_LOG_BYTES);
  assert.equal(logs.read({ session: logs.session, after: batch.cursor }).entries.length, 0);
  assert.equal(logs.read({ session: 'old-session', after: batch.cursor }).gap, true);
  assert.equal(logs.read({ session: logs.session, after: batch.cursor + 1 }).gap, true);
  for (let index = 0; index < 1100; index++) stdout.write(`${index}\n`);
  stdout.end();
  await finished(stdout);
  assert.equal(logs.read().entries.length, MAX_LOG_LINES);
  assert.equal(logs.read().entries[0]?.text, '100');
});

test('preserves an exact-size line and pages replay by encoded IPC size', async () => {
  const logs = new LogRegistry();
  const output = logs.output('app', 'stdout');
  output.write(`${'x'.repeat(MAX_LOG_LINE_BYTES)}\n`);
  assert.equal(logs.read().entries[0]?.truncated, false);
  for (let index = 0; index < 100; index++) output.write(`${'\\'.repeat(MAX_LOG_LINE_BYTES)}\n`);
  output.end();
  await finished(output);
  const first = logs.read({}, 256 * 1024);
  assert.ok(first.entries.length < logs.read().entries.length);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 260 * 1024);
  const second = logs.read({ session: logs.session, after: first.cursor }, 256 * 1024);
  assert.equal(second.entries[0]?.sequence, first.cursor + 1);
});
