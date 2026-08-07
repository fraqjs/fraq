import {
  type ContextOf,
  createPluginFactory,
  defineContext,
  type ServiceClass,
  type ServiceToken,
  serviceToken,
} from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

class ValueService {
  static readonly token = serviceToken<ValueService>('kernel/test/value');

  constructor(readonly value: string) {}
}

interface RootOptions {
  calls: string[];
  label: string;
}

interface ForkOptions {
  label?: string;
}

interface Subsystems {
  calls: string[];
  inheritedLabel: string;
}

interface Builtins {
  readonly label: string;
  readonly pluginLabel: string;
}

const Runtime = defineContext<RootOptions, ForkOptions>()
  .subsystems<Subsystems>(({ rootOptions, forkOptions, parent, subsystem }) => {
    const calls = rootOptions?.calls ?? parent?.systems.calls;
    if (!calls) {
      throw new Error('Missing calls');
    }
    const inheritedLabel = rootOptions?.label ?? forkOptions?.label ?? parent?.systems.inheritedLabel ?? 'unknown';
    subsystem({
      name: 'resource',
      create: () => calls,
      start(value) {
        value.push(`start:${inheritedLabel}`);
      },
      activate(value) {
        value.push(`activate:${inheritedLabel}`);
      },
      suspend(value) {
        value.push(`suspend:${inheritedLabel}`);
      },
      deactivate(value) {
        value.push(`deactivate:${inheritedLabel}`);
      },
      stop(value) {
        value.push(`stop:${inheritedLabel}`);
      },
    });
    return { calls, inheritedLabel };
  })
  .builtins<Builtins>(({ systems }) => ({
    label: systems.inheritedLabel,
    pluginLabel: 'context',
  }))
  .plugins({
    create({ plugin }) {
      return { pluginLabel: `plugin:${plugin.name}` };
    },
    applying({ systems, plugin }) {
      systems.calls.push(`apply:${plugin.name}`);
    },
    starting({ systems, plugin }) {
      systems.calls.push(`starting:${plugin.name}`);
    },
  })
  .wire(({ systems }) => {
    systems.calls.push(`wire:${systems.inheritedLabel}`);
    return () => {
      systems.calls.push(`unwire:${systems.inheritedLabel}`);
    };
  })
  .build();

type Context = ContextOf<typeof Runtime>;
const definePlugin = createPluginFactory<Context>();

interface ServiceContext {
  provide<T extends object>(service: ServiceClass<T>, instance: T): void;
  resolve<T extends object>(service: ServiceClass<T> | ServiceToken<T>): T;
}

const defineServicePlugin = createPluginFactory<ServiceContext>();

test('assembles builtins while keeping subsystems internal', () => {
  const calls: string[] = [];
  const context = Runtime.create({ calls, label: 'root' });

  assert.equal(context.name, 'root');
  assert.deepEqual(context.path, ['root']);
  assert.equal(context.label, 'root');
  // @ts-expect-error Subsystems are only available to Context assembly callbacks.
  void context.systems;
  assert.deepEqual(calls, ['wire:root']);
});

test('orders plugins by services and creates the plugin proxy during apply', async () => {
  const calls: string[] = [];
  const context = Runtime.create({ calls, label: 'root' });
  let applyContext: Context | undefined;
  let startContext: Context | undefined;

  context.install(
    definePlugin({
      name: 'consumer',
      inject: { value: ValueService },
      apply(ctx) {
        calls.push(`consumer:${ctx.value.value}:${ctx.pluginLabel}`);
        applyContext = ctx;
      },
      start(ctx) {
        calls.push(`consumer-start:${ctx.value.value}`);
        startContext = ctx;
      },
    }),
  );
  context.install(
    definePlugin({
      name: 'provider',
      provides: [ValueService],
      apply(ctx) {
        ctx.provide(ValueService, new ValueService('ready'));
      },
    }),
  );

  assert.equal(applyContext, undefined);
  await context.start();

  assert.notEqual(applyContext, context);
  assert.equal(startContext, applyContext);
  assert.deepEqual(calls, [
    'wire:root',
    'start:root',
    'apply:provider',
    'apply:consumer',
    'consumer:ready:plugin:consumer',
    'starting:consumer',
    'consumer-start:ready',
    'activate:root',
  ]);
});

test('defines plugins against capabilities shared by different context types', async () => {
  const context = Runtime.create({ calls: [], label: 'root' });
  const plugin = defineServicePlugin({
    name: 'common-service',
    provides: [ValueService],
    apply(ctx, value: string) {
      ctx.provide(ValueService, new ValueService(value));
    },
  });

  context.install(plugin, 'shared');
  await context.start();

  assert.equal(context.resolve(ValueService).value, 'shared');
});

test('inherits services and runs child lifecycle before parent cleanup', async () => {
  const calls: string[] = [];
  const parent = Runtime.create({ calls, label: 'parent' });
  const child = parent.fork('child', { label: 'child' });
  parent.provide(ValueService, new ValueService('inherited'));

  assert.equal(child.label, 'child');
  assert.deepEqual(child.path, ['root', 'child']);
  assert.equal(child.resolve(ValueService).value, 'inherited');
  assert.throws(() => parent.fork('child', { label: 'other' }), /already exists/);

  await parent.start();
  await parent.stop();

  assert.deepEqual(calls, [
    'wire:parent',
    'wire:child',
    'start:parent',
    'start:child',
    'activate:parent',
    'activate:child',
    'suspend:parent',
    'suspend:child',
    'deactivate:child',
    'unwire:child',
    'stop:child',
    'deactivate:parent',
    'unwire:parent',
    'stop:parent',
  ]);
});
