import { createMockMilkyClient } from '@fraqjs/mock';

import { Context, type LogMessage, type milky } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

function snapshotLog(message: LogMessage): Omit<LogMessage, 'time'> {
  const { time: _time, ...rest } = message;
  return rest;
}

test('creates contexts from client instances and starts event streams on the root context', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client);
  let receivedMessageEvents = 0;

  ctx.on('message_receive', () => {
    receivedMessageEvents += 1;
  });

  await ctx.start();
  await client.receiveFriend({ userId: 1 }, []);

  assert.equal(client.startEventCalls, 1);
  assert.equal(receivedMessageEvents, 1);
});

test('retries the event stream after startup failures', async () => {
  const client = createMockMilkyClient();
  const logs: LogMessage[] = [];
  const startError = new Error('boom');
  const ctx = Context.fromClient(client, {
    reconnect: {
      initialDelayMs: 0,
      maxDelayMs: 0,
    },
    logHandler(message) {
      logs.push(message);
    },
  });
  client.failNextStart(startError);

  await ctx.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(client.startEventCalls, 2);
  assert.deepEqual(logs.map(snapshotLog), [
    {
      level: 'debug',
      module: 'context:root',
      message: 'Connecting event source (attempt=1)',
      error: undefined,
    },
    {
      level: 'error',
      module: 'context:root',
      message: 'Error connecting event source; reconnecting in 0ms',
      error: startError,
    },
    {
      level: 'debug',
      module: 'context:root',
      message: 'Connecting event source (attempt=2)',
      error: undefined,
    },
    {
      level: 'info',
      module: 'context:root',
      message: 'Event source connected',
      error: undefined,
    },
  ]);
});

test('installs event sources explicitly', async () => {
  const client = createMockMilkyClient();
  const ctx = Context.fromClient(client);
  const received: milky.Event[] = [];
  let resolveClosed!: () => void;
  let startCalls = 0;

  ctx.installEventSource({
    name: 'manual',
    async start(onEvent) {
      startCalls += 1;
      await onEvent({
        event_type: 'bot_offline',
        time: 1,
        self_id: 1,
        data: {
          reason: 'test',
        },
      });
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      return {
        closed,
        stop() {
          resolveClosed();
        },
      };
    },
  });

  ctx.on('bot_offline', (event) => {
    received.push(event);
  });

  await ctx.start();
  await ctx.stop();

  assert.equal(startCalls, 1);
  assert.equal(received.length, 1);
});

test('fromUrl installs the websocket event source by default and can opt out', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const urls: string[] = [];

  class FakeWebSocket {
    private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

    constructor(url: string) {
      urls.push(url);
      queueMicrotask(() => {
        this.emit('open', {});
      });
    }

    addEventListener(type: string, listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void {
      const listeners = this.listeners.get(type) ?? [];
      if (options?.once) {
        const onceListener = (event: { data?: unknown }) => {
          this.removeEventListener(type, onceListener);
          listener(event);
        };
        listeners.push(onceListener);
      } else {
        listeners.push(listener);
      }
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
      const listeners = this.listeners.get(type);
      if (!listeners) {
        return;
      }
      this.listeners.set(
        type,
        listeners.filter((current) => current !== listener),
      );
    }

    close(): void {
      this.emit('close', {});
    }

    private emit(type: string, event: { data?: unknown }): void {
      for (const listener of this.listeners.get(type) ?? []) {
        void listener(event);
      }
    }
  }

  // @ts-expect-error test-only WebSocket shim
  globalThis.WebSocket = FakeWebSocket;
  try {
    const withDefaultSource = Context.fromUrl(new URL('http://localhost:30001/'));
    const withoutSource = Context.fromUrl(new URL('http://localhost:30002/'), {
      installEventSource: false,
    });

    await withDefaultSource.start();
    await withDefaultSource.stop();
    await withoutSource.start();
    await withoutSource.stop();

    assert.deepEqual(urls, ['ws://localhost:30001/event']);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});
