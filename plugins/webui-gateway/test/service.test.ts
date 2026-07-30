import { HonoService } from '@fraqjs/plugin-hono';

import { WebuiGatewayService } from '../src';

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
  const gateway = new WebuiGatewayService(
    hono,
    {
      accessToken: 'correct-token',
      sessionMaxAgeSeconds: 60,
    },
    loginRoot,
  );
  return { assetsRoot, gateway, hono, root };
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
  gateway.mount({ id: 'example', assets: assetsRoot });

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
    id: 'example',
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
  gateway.mount({ id: 'example', assets: assetsRoot });
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

test('rejects unsafe registrations and duplicate WebUI ids', async (t) => {
  const { assetsRoot, gateway, root } = await createTestGateway();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(() => gateway.mount({ id: 'Invalid ID', assets: assetsRoot }), /Invalid WebUI id/);
  assert.throws(() => gateway.mount({ id: 'invalid--id', assets: assetsRoot }), /Invalid WebUI id/);
  assert.throws(() => gateway.mount({ id: 'login', assets: assetsRoot }), /Invalid WebUI id/);
  assert.throws(() => gateway.mount({ id: 'auth', assets: assetsRoot }), /Invalid WebUI id/);
  assert.throws(() => gateway.mount({ id: 'missing', assets: join(root, 'missing') }), /does not exist/);
  gateway.mount({ id: 'example', assets: assetsRoot });
  assert.throws(() => gateway.mount({ id: 'example', assets: assetsRoot }), /already been mounted/);
});

test('keeps login redirects inside the WebUI base path', async (t) => {
  const { assetsRoot, gateway, hono, root } = await createTestGateway();
  t.after(() => rm(root, { recursive: true, force: true }));
  gateway.mount({ id: 'example', assets: assetsRoot });

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
