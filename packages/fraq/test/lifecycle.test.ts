import { createMockContext, type MockService } from '@fraqjs/plugin-mock';

import { type Context, type Disposable, definePlugin, type LogMessage, serviceToken } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

class ParentDisposableService implements Disposable {
  static readonly token = serviceToken<ParentDisposableService>('fraqjs/test/lifecycle/ParentDisposableService');

  constructor(private readonly calls: string[]) {}

  dispose(): void {
    this.calls.push('parent');
  }
}

class FirstDisposableService implements Disposable {
  static readonly token = serviceToken<FirstDisposableService>('fraqjs/test/lifecycle/FirstDisposableService');

  constructor(private readonly calls: string[]) {}

  dispose(): void {
    this.calls.push('first');
  }
}

class SecondDisposableService implements Disposable {
  static readonly token = serviceToken<SecondDisposableService>('fraqjs/test/lifecycle/SecondDisposableService');

  constructor(private readonly calls: string[]) {}

  dispose(): void {
    this.calls.push('second');
  }
}

class ChildDisposableService implements Disposable {
  static readonly token = serviceToken<ChildDisposableService>('fraqjs/test/lifecycle/ChildDisposableService');

  constructor(private readonly calls: string[]) {}

  dispose(): void {
    this.calls.push('child');
  }
}

class ScopedDisposableService implements Disposable {
  static readonly token = serviceToken<ScopedDisposableService>('fraqjs/test/lifecycle/ScopedDisposableService');

  constructor(
    private readonly name: string,
    private readonly calls: string[],
  ) {}

  dispose(): void {
    this.calls.push(this.name);
  }
}

function snapshotLog(message: LogMessage): Omit<LogMessage, 'time'> {
  const { time: _time, ...rest } = message;
  return rest;
}

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createSlowStoppingClient(): {
  ctx: Context;
  stopStarted: Promise<void>;
  resolveStopped: () => void;
} {
  const ctx = createMockContext();
  let resolveStopStarted!: () => void;
  let resolveStopped!: () => void;
  const stopStarted = new Promise<void>((resolve) => {
    resolveStopStarted = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  (ctx.mock as unknown as { start: MockService['start'] }).start = async () => ({
    closed: stopped,
    async stop() {
      resolveStopStarted();
      await stopped;
    },
  });

  return { ctx, stopStarted, resolveStopped };
}

test('event handlers can be unsubscribed', async () => {
  const ctx = createMockContext();
  let receivedMessageEvents = 0;

  const off = ctx.on('message_receive', () => {
    receivedMessageEvents += 1;
  });

  await ctx.start();
  await ctx.mock.receiveFriend({ userId: 1 }, []);
  off();
  await ctx.mock.receiveFriend({ userId: 1 }, []);

  assert.equal(receivedMessageEvents, 1);
});

test('stops the root event stream and ignores later stream events', async () => {
  const ctx = createMockContext();
  let receivedMessageEvents = 0;

  ctx.on('message_receive', () => {
    receivedMessageEvents += 1;
  });

  await ctx.start();
  await ctx.stop();
  await ctx.mock.receiveFriend({ userId: 1 }, []);

  assert.equal(ctx.mock.startEventCalls, 1);
  assert.equal(receivedMessageEvents, 0);
});

test('stops child contexts before parent services and disposes services in reverse provision order', async () => {
  const calls: string[] = [];
  const parent = createMockContext();
  const child = parent.fork('child');

  parent.provide(ParentDisposableService, new ParentDisposableService(calls));
  child.provide(FirstDisposableService, new FirstDisposableService(calls));
  child.provide(SecondDisposableService, new SecondDisposableService(calls));
  child.provide(ChildDisposableService, new ChildDisposableService(calls));

  await parent.start();
  await parent.stop();

  assert.deepEqual(calls, ['child', 'second', 'first', 'parent']);
});

test('disposes scoped services with their consuming contexts', async () => {
  const calls: string[] = [];
  const parent = createMockContext();
  const child = parent.fork('child');

  parent.provide(ParentDisposableService, new ParentDisposableService(calls));
  parent.install(
    definePlugin({
      name: 'scoped-provider',
      provides: [ScopedDisposableService],
      apply(ctx) {
        ctx.provide(
          ScopedDisposableService,
          (scope) => new ScopedDisposableService(scope.plugin ?? scope.context.name, calls),
        );
      },
    }),
  );
  parent.install(
    definePlugin({
      name: 'parent-consumer',
      inject: { scoped: ScopedDisposableService },
      apply(ctx) {
        assert.ok(ctx.scoped);
      },
    }),
  );
  child.install(
    definePlugin({
      name: 'child-consumer',
      inject: { scoped: ScopedDisposableService },
      apply(ctx) {
        assert.ok(ctx.scoped);
      },
    }),
  );

  await parent.start();
  await parent.stop();

  assert.deepEqual(calls, ['child-consumer', 'parent-consumer', 'parent']);
});

test('clears context timers when the context stops', async () => {
  const ctx = createMockContext();
  let timeoutCalls = 0;
  let intervalCalls = 0;

  ctx.timeout(0, () => {
    timeoutCalls += 1;
  });
  ctx.interval(0, () => {
    intervalCalls += 1;
  });

  await ctx.stop();
  await flushTimers();

  assert.equal(timeoutCalls, 0);
  assert.equal(intervalCalls, 0);
});

test('rejects timers scheduled after the context has stopped', async () => {
  const ctx = createMockContext();

  await ctx.start();
  await ctx.stop();

  assert.throws(() => ctx.timeout(0, () => {}), /cannot schedule timers after it has stopped/);
  assert.throws(() => ctx.interval(0, () => {}), /cannot schedule timers after it has stopped/);
});

test('rejects timers scheduled while the context is stopping', async () => {
  const { ctx, stopStarted, resolveStopped } = createSlowStoppingClient();

  await ctx.start();
  const stopPromise = ctx.stop();
  await stopStarted;

  assert.throws(() => ctx.timeout(0, () => {}), /cannot schedule timers while it is stopping/);
  assert.throws(() => ctx.interval(0, () => {}), /cannot schedule timers while it is stopping/);

  resolveStopped();
  await stopPromise;
});

test('ignores queued timer callbacks once the context is stopping', async () => {
  const { ctx, stopStarted, resolveStopped } = createSlowStoppingClient();
  let calls = 0;
  let stopPromise: Promise<void> | undefined;

  await ctx.start();
  ctx.timeout(0, () => {
    stopPromise = ctx.stop();
  });
  ctx.timeout(0, () => {
    calls += 1;
  });
  await stopStarted;
  await flushTimers();
  resolveStopped();
  await stopPromise;

  assert.equal(calls, 0);
});

test('stops child context timers before waiting for the parent event stream to stop', async () => {
  const { ctx: parent, stopStarted, resolveStopped } = createSlowStoppingClient();
  const child = parent.fork('child');
  let calls = 0;

  child.interval(0, () => {
    calls += 1;
  });

  await parent.start();
  const stopPromise = parent.stop();
  await stopStarted;
  await flushTimers();
  resolveStopped();
  await stopPromise;

  assert.equal(calls, 0);
});

test('stopping clears pending timeouts but does not revisit completed timeouts', async (t) => {
  const ctx = createMockContext();
  t.after(() => ctx.stop());
  let completed!: NodeJS.Timeout;

  await ctx.start();
  await new Promise<void>((resolve) => {
    completed = ctx.timeout(0, resolve);
  });
  const pending = ctx.timeout(60_000, () => {});
  const clearTimer = t.mock.method(globalThis, 'clearTimeout');

  await ctx.stop();

  const cleared = clearTimer.mock.calls.map((call) => call.arguments[0]);
  assert.equal(cleared.includes(completed), false);
  assert.equal(cleared.includes(pending), true);
});

test('logs timer callback errors', async () => {
  const logs: LogMessage[] = [];
  const error = new Error('boom');
  const ctx = createMockContext({
    logHandler(message) {
      logs.push(message);
    },
  });

  await ctx.start();
  ctx.timeout(0, () => {
    throw error;
  });
  await flushTimers();
  await ctx.stop();

  assert.deepEqual(logs.map(snapshotLog).at(-1), {
    level: 'error',
    module: 'context:root',
    message: 'Error handling timer callback',
    error,
  });
});

test('applies the context tree before starting plugins from parents to children', async () => {
  const calls: string[] = [];
  const parent = createMockContext();
  const child = parent.fork('child');

  parent.install(
    definePlugin({
      name: 'parent',
      apply() {
        calls.push('parent apply');
      },
      start() {
        calls.push('parent start');
      },
    }),
  );
  child.install(
    definePlugin({
      name: 'child',
      apply() {
        calls.push('child apply');
      },
      start() {
        calls.push('child start');
      },
    }),
  );

  await parent.start();

  assert.deepEqual(calls, ['parent apply', 'child apply', 'parent start', 'child start']);
});

test('recovers the parent context state when a child context fails to start', async () => {
  const parent = createMockContext();
  const child = parent.fork('child');
  let applyCalls = 0;
  let shouldThrow = true;

  child.install(
    definePlugin({
      name: 'flaky-child',
      apply() {
        applyCalls += 1;
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error('boom');
        }
      },
    }),
  );

  await assert.rejects(() => parent.start(), /boom/);
  await child.start();
  assert.equal(applyCalls, 2);

  await parent.start();

  assert.equal(parent.mock.startEventCalls, 1);
});
