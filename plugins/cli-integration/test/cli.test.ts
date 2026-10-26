import { ControlError } from '@fraqjs/cli-protocol';

import { CliClient, type IpcTransport } from '../src/cli';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

function transport(): IpcTransport {
  return Object.assign(new EventEmitter(), { connected: true });
}

test('correlates out-of-order IPC responses and rejects incompatible versions and disconnects', async (t) => {
  const channel = transport();
  const client = new CliClient(channel, 1000);
  t.after(() => client.dispose());
  const requests: Array<{ id: string }> = [];
  channel.send = (message, callback) => {
    requests.push(message as { id: string });
    callback(null);
    return true;
  };
  const first = client.request('hello', undefined);
  const second = client.request('hello', undefined);
  channel.emit('message', {
    type: 'fraq:control:response',
    version: 1,
    id: 'unrelated',
    result: { capabilities: ['wrong'] },
  });
  channel.emit('message', {
    type: 'fraq:control:response',
    version: 1,
    id: requests[1].id,
    result: { version: 1, capabilities: ['second'] },
  });
  channel.emit('message', {
    type: 'fraq:control:response',
    version: 1,
    id: requests[0].id,
    result: { version: 1, capabilities: ['first'] },
  });
  assert.deepEqual((await first).capabilities, ['first']);
  assert.deepEqual((await second).capabilities, ['second']);
  const incompatible = client.request('hello', undefined);
  const rejection = assert.rejects(
    incompatible,
    (error: unknown) => error instanceof ControlError && error.code === 'unavailable',
  );
  channel.emit('message', { type: 'fraq:control:response', version: 2, id: requests[2].id, result: {} });
  await rejection;
  const pending = client.request('status', undefined);
  channel.emit('disconnect');
  await assert.rejects(pending, /断开/);
  assert.equal(channel.listenerCount('message'), 0);
  await assert.rejects(client.request('status', undefined), /断开/);
});

test('timeouts release request capacity and late responses cannot settle a newer request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channel = transport();
  const ids: string[] = [];
  channel.send = (message) => {
    ids.push((message as { id: string }).id);
    return true;
  };
  const client = new CliClient(channel, 10);
  t.after(() => client.dispose());
  // More requests than the concurrent capacity: stale pending entries must not accumulate.
  for (let index = 0; index < 64; index++) {
    const rejection = assert.rejects(
      client.request('hello', undefined),
      (error: unknown) => error instanceof ControlError && error.code === 'timeout',
    );
    t.mock.timers.tick(10);
    await rejection;
  }
  const pending = client.request('hello', undefined);
  channel.emit('message', {
    type: 'fraq:control:response',
    version: 1,
    id: ids[0],
    result: { version: 1, capabilities: ['late'] },
  });
  channel.emit('message', {
    type: 'fraq:control:response',
    version: 1,
    id: ids.at(-1),
    result: { version: 1, capabilities: ['current'] },
  });
  assert.deepEqual((await pending).capabilities, ['current']);
});
