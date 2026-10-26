import { createMockContext } from '@fraqjs/plugin-mock';

import { Context, type LogMessage, type milky } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

test('retries startup failures and delivers events after reconnecting', async (t) => {
  const logs: LogMessage[] = [];
  const startError = new Error('boom');
  const ctx = createMockContext({
    reconnect: { initialDelayMs: 0, maxDelayMs: 0 },
    logHandler: (message) => logs.push(message),
  });
  t.after(() => ctx.stop());
  let received = 0;
  ctx.on('message_receive', () => {
    received++;
  });
  ctx.mock.failNextStart(startError);
  await ctx.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.mock.receiveFriend({ userId: 1 }, []);
  assert.equal(ctx.mock.startEventCalls, 2);
  assert.equal(received, 1);
  assert.ok(logs.some((message) => message.level === 'error' && message.error === startError));
});

test('installs event sources explicitly', async () => {
  const ctx = createMockContext();
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

test('event sources installed after startup start once and stop with the context', async () => {
  const ctx = createMockContext();
  let startCalls = 0;
  let stopCalls = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const source = {
    async start() {
      startCalls += 1;
      return {
        closed,
        stop() {
          stopCalls += 1;
          resolveClosed();
        },
      };
    },
  };

  await ctx.start();
  ctx.installEventSource(source);
  ctx.installEventSource(source);
  await ctx.stop();

  assert.equal(startCalls, 1);
  assert.equal(stopCalls, 1);
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
