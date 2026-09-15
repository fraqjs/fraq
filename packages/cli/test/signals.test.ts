import { SignalRegistry } from '../src/app/signals';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

test('registers once, escalates repeated signals and preserves the first exit code', async () => {
  const target = new EventEmitter();
  const baseline = () => {};
  target.on('SIGTERM', baseline);
  const forwarded: NodeJS.Signals[] = [];
  const signals = new SignalRegistry((signal) => forwarded.push(signal), target);
  signals.start();
  signals.start();
  assert.equal(target.listenerCount('SIGTERM'), 2);
  target.emit('SIGTERM');
  target.emit('SIGINT');
  assert.deepEqual(forwarded, ['SIGTERM', 'SIGKILL']);
  assert.equal(await signals.exit, 143);
  assert.equal(signals.exitCode, 143);
  signals.close();
  signals.close();
  assert.deepEqual(target.listeners('SIGTERM'), [baseline]);
  assert.equal(target.listenerCount('SIGINT'), 0);
});
