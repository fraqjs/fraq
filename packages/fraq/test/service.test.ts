import { createMockContext } from '@fraqjs/plugin-mock';

import { definePlugin, type ServiceScope, serviceToken } from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

class AlphaService {
  static readonly token = serviceToken<AlphaService>('fraqjs/test/service/AlphaService');

  readonly value = 'alpha';
}

class AlternateAlphaService {
  static readonly token = serviceToken<AlternateAlphaService>('fraqjs/test/service/AlphaService');

  readonly value = 'alternate-alpha';
}

class BetaService {
  static readonly token = serviceToken<BetaService>('fraqjs/test/service/BetaService');

  constructor(readonly alpha: AlphaService) {}
}

class GammaService {
  static readonly token = serviceToken<GammaService>('fraqjs/test/service/GammaService');

  readonly value = 'gamma';
}

class ScopedService {
  static readonly token = serviceToken<ScopedService>('fraqjs/test/service/ScopedService');

  constructor(readonly scope: ServiceScope) {}
}

test('provides and resolves service instances by class', () => {
  const ctx = createMockContext();
  const alpha = new AlphaService();

  ctx.provide(AlphaService, alpha);

  const resolved: AlphaService = ctx.resolve(AlphaService);
  assert.equal(resolved, alpha);
});

test('resolves services with an independently created token', () => {
  const ctx = createMockContext();
  const alpha = new AlphaService();
  const token = serviceToken<AlphaService>('fraqjs/test/service/AlphaService');

  ctx.provide(AlphaService, alpha);

  assert.equal(ctx.resolve(token), alpha);
  assert.equal(ctx.tryResolve(token), alpha);
  assert.equal(ctx.isProvided(token), true);
});

test('reports missing services through resolve, tryResolve, and has', () => {
  const ctx = createMockContext();

  assert.throws(() => ctx.resolve(AlphaService), /AlphaService/);
  assert.equal(ctx.tryResolve(AlphaService), undefined);
  assert.equal(ctx.isProvided(AlphaService), false);
});

test('rejects duplicate service tokens in the same context', () => {
  const ctx = createMockContext();

  ctx.provide(AlphaService, new AlphaService());

  assert.throws(() => ctx.provide(AlphaService, new AlphaService()), /already been provided/);
  assert.throws(() => ctx.provide(AlternateAlphaService, new AlternateAlphaService()), /already been provided/);
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

test('does not require optional injections without installed providers', async () => {
  const ctx = createMockContext();
  const calls: string[] = [];

  ctx.install(
    definePlugin({
      name: 'alpha-consumer',
      optionalInject: { alpha: AlphaService.token },
      apply(ctx) {
        calls.push('consumer');
        assert.equal(ctx.alpha, undefined);
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
        alpha: serviceToken<AlphaService>('fraqjs/test/service/AlphaService'),
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

test('breaks cycles between optional service dependencies', async () => {
  const ctx = createMockContext();
  const calls: string[] = [];

  ctx.install(
    definePlugin({
      name: 'alpha-provider',
      optionalInject: { beta: BetaService.token },
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
      optionalInject: { alpha: AlphaService.token },
      provides: [BetaService],
      apply(ctx) {
        calls.push('beta');
        assert.ok(ctx.alpha);
        ctx.provide(BetaService, new BetaService(ctx.alpha));
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
      name: 'injects-alpha',
      inject: { alpha: AlphaService },
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
      inject: { beta: BetaService },
      provides: [AlphaService],
      apply(ctx) {
        ctx.provide(AlphaService, new AlphaService());
      },
    }),
  );
  ctx.install(
    definePlugin({
      name: 'cycle-beta-provider',
      inject: { alpha: AlphaService },
      provides: [BetaService],
      apply(ctx) {
        ctx.provide(BetaService, new BetaService(ctx.alpha));
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
      inject: { alpha: AlphaService },
      provides: [BetaService],
      apply(ctx) {
        ctx.provide(BetaService, new BetaService(ctx.alpha));
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
      inject: { alpha: AlphaService },
      provides: [GammaService],
      apply(ctx) {
        assert.equal(ctx.alpha, alpha);
        ctx.provide(GammaService, new GammaService());
      },
    }),
  );

  await ctx.start();

  assert.ok(ctx.resolve(GammaService) instanceof GammaService);
});
