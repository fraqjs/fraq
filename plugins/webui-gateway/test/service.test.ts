import { definePlugin } from '@fraqjs/fraq';
import { HonoService } from '@fraqjs/plugin-hono';
import { createMockContext } from '@fraqjs/plugin-mock';

import { WebuiGatewayPlugin, WebuiGatewayService } from '../src';
import { WebuiGateway } from '../src/gateway';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

interface TestGateway {
  assetsRoot: string;
  gateway: WebuiGatewayService;
  hono: HonoService;
  root: string;
  sharedGateway: WebuiGateway;
}

async function createTestGateway(): Promise<TestGateway> {
  const root = await mkdtemp(join(tmpdir(), 'fraq-webui-gateway-'));
  const loginRoot = join(root, 'login');
  const assetsRoot = join(root, 'example');
  await mkdir(join(loginRoot, 'assets'), { recursive: true });
  await mkdir(join(assetsRoot, 'assets'), { recursive: true });
  await writeFile(join(loginRoot, 'index.html'), '<h1>Fraq login</h1>');
  await writeFile(join(loginRoot, 'assets', 'login.js'), 'console.log("login")');
  await writeFile(join(assetsRoot, 'index.html'), '<h1>Example WebUI</h1>');
  await writeFile(join(assetsRoot, 'assets', 'app.js'), 'console.log("example")');

  const hono = new HonoService();
  const sharedGateway = new WebuiGateway(
    hono,
    {
      accessToken: 'correct-token',
      sessionMaxAgeSeconds: 60,
    },
    loginRoot,
  );
  const gateway = new WebuiGatewayService((options) => sharedGateway.mount('example', options));
  return { assetsRoot, gateway, hono, root, sharedGateway };
}

async function login(hono: HonoService, returnTo = '/webui/example/'): Promise<string> {
  const response = await hono.app.request('/webui/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: 'correct-token', returnTo }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('Set-Cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

test('serves the public login page and protects mounted pages', async (t) => {
  const { assetsRoot, gateway, hono, root } = await createTestGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  gateway.mount({ assets: assetsRoot });

  const loginResponse = await hono.app.request('/webui/login/');
  assert.equal(loginResponse.status, 200);
  assert.equal(await loginResponse.text(), '<h1>Fraq login</h1>');

  const protectedResponse = await hono.app.request('/webui/example/settings?tab=profile', {
    headers: { Accept: 'text/html' },
  });
  assert.equal(protectedResponse.status, 302);
  assert.equal(
    protectedResponse.headers.get('Location'),
    '/webui/login/?returnTo=%2Fwebui%2Fexample%2Fsettings%3Ftab%3Dprofile',
  );
});

test('creates a signed session and exposes it to limited API handlers', async (t) => {
  const { assetsRoot, gateway, hono, root } = await createTestGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  gateway.mount({
    assets: assetsRoot,
    routes(api) {
      api.get('/session', (c, session) => c.json({ authenticatedAt: session.authenticatedAt }));
    },
  });

  const unauthorized = await hono.app.request('/webui/example/api/session');
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: 'Unauthorized' });

  const invalidLogin = await hono.app.request('/webui/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: 'wrong-token' }),
  });
  assert.equal(invalidLogin.status, 401);

  const cookie = await login(hono);
  const authorized = await hono.app.request('/webui/example/api/session', {
    headers: { Cookie: cookie },
  });
  assert.equal(authorized.status, 200);
  const body = (await authorized.json()) as { authenticatedAt: number };
  assert.equal(typeof body.authenticatedAt, 'number');

  const session = await hono.app.request('/webui/auth/session', { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.equal(((await session.json()) as { authenticated: boolean }).authenticated, true);
});

test('serves assets and only uses the SPA fallback for HTML navigation', async (t) => {
  const { assetsRoot, gateway, hono, root } = await createTestGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  gateway.mount({ assets: assetsRoot });
  const cookie = await login(hono);
  const headers = { Cookie: cookie };

  const asset = await hono.app.request('/webui/example/assets/app.js', { headers });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'console.log("example")');
  assert.equal(asset.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');

  const deepRoute = await hono.app.request('/webui/example/settings/profile', {
    headers: { ...headers, Accept: 'text/html,application/xhtml+xml' },
  });
  assert.equal(deepRoute.status, 200);
  assert.equal(await deepRoute.text(), '<h1>Example WebUI</h1>');
  assert.equal(deepRoute.headers.get('Cache-Control'), 'no-cache');

  const missingAsset = await hono.app.request('/webui/example/assets/missing.js', {
    headers: { ...headers, Accept: '*/*' },
  });
  assert.equal(missingAsset.status, 404);
});

test('rejects unsafe plugin names and duplicate WebUI mounts', async (t) => {
  const { assetsRoot, gateway, root, sharedGateway } = await createTestGateway();
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const name of ['Invalid ID', 'invalid--id', 'login', 'auth']) {
    const specializedGateway = new WebuiGatewayService((options) => sharedGateway.mount(name, options));
    assert.throws(() => specializedGateway.mount({ assets: assetsRoot }), /cannot be used as a WebUI id/);
  }
  const missingGateway = new WebuiGatewayService((options) => sharedGateway.mount('missing', options));
  assert.throws(() => missingGateway.mount({ assets: join(root, 'missing') }), /does not exist/);
  gateway.mount({ assets: assetsRoot });
  assert.throws(() => gateway.mount({ assets: assetsRoot }), /already been mounted/);
});

test('keeps login redirects inside the WebUI base path', async (t) => {
  const { assetsRoot, gateway, hono, root } = await createTestGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  gateway.mount({ assets: assetsRoot });

  for (const returnTo of ['https://example.com/', '//example.com/', '/outside', '/webui/login/']) {
    const response = await hono.app.request('/webui/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: 'correct-token', returnTo }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { redirectTo: '/webui/example/' });
  }
});

test('logout clears an existing session', async (t) => {
  const { hono, root } = await createTestGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  const cookie = await login(hono);

  const response = await hono.app.request('/webui/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie') ?? '', /fraq_webui_session=;/);
});

test('provides a specialized service to each plugin while sharing one Hono app', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fraq-webui-gateway-scoped-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstAssets = join(root, 'first');
  const secondAssets = join(root, 'second');
  await mkdir(firstAssets, { recursive: true });
  await mkdir(secondAssets, { recursive: true });
  await writeFile(join(firstAssets, 'index.html'), '<h1>First WebUI</h1>');
  await writeFile(join(secondAssets, 'index.html'), '<h1>Second WebUI</h1>');

  const ctx = createMockContext();
  const hono = new HonoService();
  const services: WebuiGatewayService[] = [];
  ctx.provide(HonoService, hono);
  ctx.install(WebuiGatewayPlugin, { accessToken: 'correct-token' });
  for (const [name, assets] of [
    ['first-plugin', firstAssets],
    ['second-plugin', secondAssets],
  ] as const) {
    ctx.install(
      definePlugin({
        name,
        inject: { webui: WebuiGatewayService },
        apply(ctx) {
          services.push(ctx.webui);
          ctx.webui.mount({ assets });
        },
      }),
    );
  }

  await ctx.start();

  assert.equal(services.length, 2);
  assert.notEqual(services[0], services[1]);
  assert.throws(() => ctx.resolve(WebuiGatewayService), /can only be resolved by a plugin/);
  const cookie = await login(hono, '/webui/first-plugin/');
  const headers = { Accept: 'text/html', Cookie: cookie };
  const first = await hono.app.request('/webui/first-plugin/', { headers });
  const second = await hono.app.request('/webui/second-plugin/', { headers });
  assert.equal(await first.text(), '<h1>First WebUI</h1>');
  assert.equal(await second.text(), '<h1>Second WebUI</h1>');
});
