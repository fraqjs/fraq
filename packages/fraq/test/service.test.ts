import { createMockContext } from '@fraqjs/plugin-mock';

import { definePlugin, type ServiceScope } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

class AlphaService {
  readonly value = 'alpha';
}

class BetaService {
  constructor(readonly alpha: AlphaService) {}
}

class GammaService {}

class ScopedService {
  constructor(readonly scope: ServiceScope) {}
}

test('provides and resolves service instances by class', () => {
  const ctx = createMockContext();
  const alpha = new AlphaService();

  ctx.provide(AlphaService, alpha);

  const resolved: AlphaService = ctx.resolve(AlphaService);
  assert.equal(resolved, alpha);
});

test('reports missing services through resolve, tryResolve, and has', () => {
  const ctx = createMockContext();

  assert.throws(() => ctx.resolve(AlphaService), /AlphaService/);
  assert.equal(ctx.tryResolve(AlphaService), undefined);
  assert.equal(ctx.isProvided(AlphaService), false);
});

test('rejects duplicate service providers in the same context', () => {
  const ctx = createMockContext();

  ctx.provide(AlphaService, new AlphaService());

  assert.throws(() => ctx.provide(AlphaService, new AlphaService()), /already been provided/);
});

test('sub contexts inherit parent services', () => {
  const parent = createMockContext();
  const child = parent.fork('child');
  const alpha = new AlphaService();

  parent.provide(AlphaService, alpha);

  assert.equal(child.resolve(AlphaService), alpha);
});

test('sub contexts can override parent services without affecting parent', () => {
  const parent = createMockContext();
  const child = parent.fork('child');
  const parentAlpha = new AlphaService();
  const childAlpha = new AlphaService();

  parent.provide(AlphaService, parentAlpha);
  child.provide(AlphaService, childAlpha);

  assert.equal(parent.resolve(AlphaService), parentAlpha);
  assert.equal(child.resolve(AlphaService), childAlpha);
});

test('sorts plugins by service dependencies', async () => {
  const ctx = createMockContext();
  const calls: string[] = [];

  const BetaPlugin = definePlugin({
    name: 'beta',
    requires: [AlphaService],
    provides: [BetaService],
    apply(ctx) {
      calls.push('beta');
      ctx.provide(BetaService, new BetaService(ctx.resolve(AlphaService)));
    },
  });
  const AlphaPlugin = definePlugin({
    name: 'alpha',
    provides: [AlphaService],
    apply(ctx) {
      calls.push('alpha');
      ctx.provide(AlphaService, new AlphaService());
    },
  });

  ctx.install(BetaPlugin);
  ctx.install(AlphaPlugin);

  await ctx.start();

  assert.deepEqual(calls, ['alpha', 'beta']);
  assert.equal(ctx.resolve(BetaService).alpha, ctx.resolve(AlphaService));
});

test('injects existing services onto plugin context proxies', async () => {
  const ctx = createMockContext();
  const alpha = new AlphaService();
  let injectedAlpha: AlphaService | undefined;

  ctx.provide(AlphaService, alpha);
  ctx.install(
    definePlugin({
      name: 'alpha-consumer',
      inject: {
        alpha: AlphaService,
      },
      apply(ctx) {
        injectedAlpha = ctx.alpha;
      },
    }),
  );

  await ctx.start();

  assert.equal(injectedAlpha, alpha);
});

test('uses injected services to order and apply plugin dependencies', async () => {
  const ctx = createMockContext();
  const calls: string[] = [];
  let injectedAlpha: AlphaService | undefined;

  ctx.install(
    definePlugin({
      name: 'beta-provider',
      inject: {
        alpha: AlphaService,
      },
      provides: [BetaService],
      apply(ctx) {
        calls.push('beta');
        injectedAlpha = ctx.alpha;
        ctx.provide(BetaService, new BetaService(ctx.alpha));
      },
    }),
  );
  ctx.install(
    definePlugin({
      name: 'alpha-provider',
      provides: [AlphaService],
      apply(ctx) {
        calls.push('alpha');
        ctx.provide(AlphaService, new AlphaService());
      },
    }),
  );

  await ctx.start();

  assert.deepEqual(calls, ['alpha', 'beta']);
  assert.equal(ctx.resolve(BetaService).alpha, injectedAlpha);
  assert.equal(injectedAlpha, ctx.resolve(AlphaService));
});

test('orders plugins by optional service dependencies when providers are installed', async () => {
  const ctx = createMockContext();
  const calls: string[] = [];

  ctx.install(
    definePlugin({
      name: 'alpha-consumer',
      optionalRequires: [AlphaService],
      apply() {
        calls.push('consumer');
      },
    }),
  );
  ctx.install(
    definePlugin({
      name: 'alpha-provider',
      provides: [AlphaService],
      apply(ctx) {
        calls.push('alpha');
        ctx.provide(AlphaService, new AlphaService());
      },
    }),
  );

  await ctx.start();

  assert.deepEqual(calls, ['alpha', 'consumer']);
});

test('does not require optional service dependencies without installed providers', async () => {
  const ctx = createMockContext();
  const calls: string[] = [];

  ctx.install(
    definePlugin({
      name: 'alpha-consumer',
      optionalRequires: [AlphaService],
      apply(ctx) {
        calls.push('consumer');
        assert.equal(ctx.tryResolve(AlphaService), undefined);
      },
    }),
  );

  await ctx.start();

  assert.deepEqual(calls, ['consumer']);
});

test('uses optional injections to order plugins when providers are installed', async () => {
  const ctx = createMockContext();
  const calls: string[] = [];
  let injectedAlpha: AlphaService | undefined;

  ctx.install(
    definePlugin({
      name: 'alpha-consumer',
      optionalInject: {
        alpha: AlphaService,
      },
      apply(ctx) {
        calls.push('consumer');
        injectedAlpha = ctx.alpha;
      },
    }),
  );
  ctx.install(
    definePlugin({
      name: 'alpha-provider',
      provides: [AlphaService],
      apply(ctx) {
        calls.push('alpha');
        ctx.provide(AlphaService, new AlphaService());
      },
    }),
  );

  await ctx.start();

  assert.deepEqual(calls, ['alpha', 'consumer']);
  assert.equal(injectedAlpha, ctx.resolve(AlphaService));
});

test('injects undefined for optional services without installed providers', async () => {
  const ctx = createMockContext();
  let injectedAlpha: AlphaService | undefined = new AlphaService();

  ctx.install(
    definePlugin({
      name: 'alpha-consumer',
      optionalInject: {
        alpha: AlphaService,
      },
      apply(ctx) {
        injectedAlpha = ctx.alpha;
      },
    }),
  );

  await ctx.start();

  assert.equal(injectedAlpha, undefined);
});

test('breaks cycles between optional service dependencies', async () => {
  const ctx = createMockContext();
  const calls: string[] = [];

  ctx.install(
    definePlugin({
      name: 'alpha-provider',
      optionalRequires: [BetaService],
      provides: [AlphaService],
      apply(ctx) {
        calls.push('alpha');
        ctx.provide(AlphaService, new AlphaService());
      },
    }),
  );
  ctx.install(
    definePlugin({
      name: 'beta-provider',
      optionalRequires: [AlphaService],
      provides: [BetaService],
      apply(ctx) {
        calls.push('beta');
        ctx.provide(BetaService, new BetaService(ctx.resolve(AlphaService)));
      },
    }),
  );

  await ctx.start();

  assert.deepEqual(calls, ['alpha', 'beta']);
});

test('preserves install order when plugins do not depend on each other', async () => {
  const ctx = createMockContext();
  const calls: string[] = [];

  ctx.install(
    definePlugin({
      name: 'first',
      apply() {
        calls.push('first');
      },
    }),
  );
  ctx.install(
    definePlugin({
      name: 'second',
      apply() {
        calls.push('second');
      },
    }),
  );

  await ctx.start();

  assert.deepEqual(calls, ['first', 'second']);
});

test('rejects startup when a required service is missing', async () => {
  const ctx = createMockContext();

  ctx.install(
    definePlugin({
      name: 'requires-alpha',
      requires: [AlphaService],
      apply() {},
    }),
  );

  await assert.rejects(() => ctx.start(), /AlphaService.*no installed plugin provides it/);
});

test('rejects startup when multiple plugins declare the same provided service', async () => {
  const ctx = createMockContext();

  ctx.install(
    definePlugin({
      name: 'alpha-provider-a',
      provides: [AlphaService],
      apply(ctx) {
        ctx.provide(AlphaService, new AlphaService());
      },
    }),
  );
  ctx.install(
    definePlugin({
      name: 'alpha-provider-b',
      provides: [AlphaService],
      apply(ctx) {
        ctx.provide(AlphaService, new AlphaService());
      },
    }),
  );

  await assert.rejects(() => ctx.start(), /AlphaService.*multiple plugins/);
});

test('rejects startup when plugin service dependencies form a cycle', async () => {
  const ctx = createMockContext();

  ctx.install(
    definePlugin({
      name: 'cycle-alpha-provider',
      requires: [BetaService],
      provides: [AlphaService],
      apply(ctx) {
        ctx.provide(AlphaService, new AlphaService());
      },
    }),
  );
  ctx.install(
    definePlugin({
      name: 'cycle-beta-provider',
      requires: [AlphaService],
      provides: [BetaService],
      apply(ctx) {
        ctx.provide(BetaService, new BetaService(ctx.resolve(AlphaService)));
      },
    }),
  );

  await assert.rejects(() => ctx.start(), /dependency cycle/);
});

test('rejects startup when a plugin declares but does not provide a service', async () => {
  const ctx = createMockContext();

  ctx.install(
    definePlugin({
      name: 'missing-alpha-provider',
      provides: [AlphaService],
      apply() {},
    }),
  );

  await assert.rejects(() => ctx.start(), /declares service AlphaService but did not provide it/);
});

test('does not count inherited services as provided by a child plugin', async () => {
  const parent = createMockContext();
  const child = parent.fork('child');

  parent.provide(AlphaService, new AlphaService());
  child.install(
    definePlugin({
      name: 'inherited-alpha-provider',
      provides: [AlphaService],
      apply() {},
    }),
  );

  await assert.rejects(() => child.start(), /declares service AlphaService but did not provide it/);
});

test('rejects startup when a plugin throws and skips later plugins', async () => {
  const ctx = createMockContext();
  const calls: string[] = [];

  ctx.install(
    definePlugin({
      name: 'throwing',
      apply() {
        calls.push('throwing');
        throw new Error('boom');
      },
    }),
  );
  ctx.install(
    definePlugin({
      name: 'later',
      apply() {
        calls.push('later');
      },
    }),
  );

  await assert.rejects(() => ctx.start(), /boom/);
  assert.deepEqual(calls, ['throwing']);
});

test('uses services from parent contexts to satisfy plugin dependencies', async () => {
  const parent = createMockContext();
  const child = parent.fork('child');
  const alpha = new AlphaService();

  parent.provide(AlphaService, alpha);
  child.install(
    definePlugin({
      name: 'beta-from-parent-alpha',
      requires: [AlphaService],
      provides: [BetaService],
      apply(ctx) {
        ctx.provide(BetaService, new BetaService(ctx.resolve(AlphaService)));
      },
    }),
  );

  await child.start();

  assert.equal(child.resolve(BetaService).alpha, alpha);
});

test('allows a sub context plugin to override a parent service', async () => {
  const parent = createMockContext();
  const child = parent.fork('child');
  const parentAlpha = new AlphaService();

  parent.provide(AlphaService, parentAlpha);
  child.install(
    definePlugin({
      name: 'child-alpha-provider',
      provides: [AlphaService],
      apply(ctx) {
        ctx.provide(AlphaService, new AlphaService());
      },
    }),
  );

  await child.start();

  assert.notEqual(child.resolve(AlphaService), parentAlpha);
  assert.equal(parent.resolve(AlphaService), parentAlpha);
});

test('creates one scoped service instance for each consuming plugin', async () => {
  const ctx = createMockContext();
  const scopes: ServiceScope[] = [];
  const instances: ScopedService[] = [];

  ctx.install(
    definePlugin({
      name: 'scoped-provider',
      provides: [ScopedService],
      apply(ctx) {
        ctx.provide(ScopedService, (scope) => {
          scopes.push(scope);
          return new ScopedService(scope);
        });
      },
    }),
  );
  for (const name of ['first-consumer', 'second-consumer']) {
    ctx.install(
      definePlugin({
        name,
        inject: {
          scoped: ScopedService,
        },
        apply(ctx) {
          assert.equal(ctx.scoped, ctx.resolve(ScopedService));
          assert.equal(ctx.scoped.scope.context, ctx);
          assert.equal(ctx.isProvided(ScopedService), true);
          instances.push(ctx.scoped);
        },
        start(ctx) {
          assert.equal(ctx.scoped, instances.at(name === 'first-consumer' ? 0 : 1));
        },
      }),
    );
  }

  await ctx.start();

  assert.equal(scopes.length, 2);
  assert.notEqual(instances[0], instances[1]);
  assert.deepEqual(
    scopes.map(({ contextPath, plugin }) => ({ contextPath, plugin })),
    [
      { contextPath: ['root'], plugin: 'first-consumer' },
      { contextPath: ['root'], plugin: 'second-consumer' },
    ],
  );
});

test('resolves scoped services inherited from parent contexts for the child consumer scope', async () => {
  const parent = createMockContext();
  const child = parent.fork('child');
  let parentInstance: ScopedService | undefined;
  let childInstance: ScopedService | undefined;

  parent.install(
    definePlugin({
      name: 'scoped-provider',
      provides: [ScopedService],
      apply(ctx) {
        ctx.provide(ScopedService, (scope) => new ScopedService(scope));
      },
    }),
  );
  parent.install(
    definePlugin({
      name: 'parent-consumer',
      inject: { scoped: ScopedService },
      apply(ctx) {
        parentInstance = ctx.scoped;
      },
    }),
  );
  child.install(
    definePlugin({
      name: 'child-consumer',
      inject: { scoped: ScopedService },
      apply(ctx) {
        childInstance = ctx.scoped;
      },
    }),
  );

  await parent.start();

  assert.ok(parentInstance);
  assert.ok(childInstance);
  assert.notEqual(parentInstance, childInstance);
  assert.deepEqual(parentInstance.scope.contextPath, ['root']);
  assert.equal(parentInstance.scope.plugin, 'parent-consumer');
  assert.deepEqual(childInstance.scope.contextPath, ['root', 'child']);
  assert.equal(childInstance.scope.plugin, 'child-consumer');
});

test('resolves a stable context scope outside plugins', async () => {
  const ctx = createMockContext();
  let factoryCalls = 0;

  ctx.install(
    definePlugin({
      name: 'scoped-provider',
      provides: [ScopedService],
      apply(ctx) {
        ctx.provide(ScopedService, (scope) => {
          factoryCalls += 1;
          return new ScopedService(scope);
        });
      },
    }),
  );

  await ctx.start();

  assert.equal(ctx.isProvided(ScopedService), true);
  assert.equal(factoryCalls, 0);
  const instance = ctx.resolve(ScopedService);
  assert.equal(ctx.tryResolve(ScopedService), instance);
  assert.equal(factoryCalls, 1);
  assert.equal(instance.scope.context, ctx);
  assert.deepEqual(instance.scope.contextPath, ['root']);
  assert.equal(instance.scope.plugin, undefined);
});

test('resolves dependencies against services provided before startup', async () => {
  const ctx = createMockContext();
  const alpha = new AlphaService();

  ctx.provide(AlphaService, alpha);
  ctx.install(
    definePlugin({
      name: 'gamma-from-existing-alpha',
      requires: [AlphaService],
      provides: [GammaService],
      apply(ctx) {
        assert.equal(ctx.resolve(AlphaService), alpha);
        ctx.provide(GammaService, new GammaService());
      },
    }),
  );

  await ctx.start();

  assert.ok(ctx.resolve(GammaService) instanceof GammaService);
});
