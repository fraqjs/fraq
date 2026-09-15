import { ControlError } from '@fraqjs/cli-protocol';

import { CliClient, type IpcTransport } from '../src/cli';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

function transport(): IpcTransport {
  return Object.assign(new EventEmitter(), { connected: true });
}

test('correlates IPC responses and rejects incompatible versions and disconnects', async () => {
  const channel = transport();
  const client = new CliClient(channel, 100);
  let version = 1;
  channel.send = (message, callback) => {
    const request = message as { id: string };
    queueMicrotask(() =>
      channel.emit('message', {
        type: 'fraq:control:response',
        version,
        id: request.id,
        result: { version: 1, capabilities: ['logs'] },
      }),
    );
    callback(null);
    return true;
  };
  assert.equal((await client.request('hello', undefined)).version, 1);
  version = 2;
  await assert.rejects(client.request('hello', undefined), /版本不兼容/);
  channel.send = () => true;
  const pending = client.request('status', undefined);
  channel.emit('disconnect');
  await assert.rejects(pending, /断开/);
  assert.equal(channel.listenerCount('message'), 0);
  await assert.rejects(client.request('status', undefined), /断开/);
});

test('bounds IPC waiting time and removes pending requests', async () => {
  const channel = transport();
  channel.send = () => true;
  const client = new CliClient(channel, 10);
  try {
    await assert.rejects(
      client.request('status', undefined),
      (error: unknown) => error instanceof ControlError && error.code === 'timeout',
    );
  } finally {
    client.dispose();
  }
});
