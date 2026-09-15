import { type ControlClient, ControlError, type Method } from '@fraqjs/cli-protocol';
import { HonoService } from '@fraqjs/plugin-hono';

import { WebuiGateway } from '../../webui-gateway/src/gateway';
import { CliIntegrationService } from '../src/service';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const base = '/webui/cli-integration/api';

test('protects APIs, rejects cross-origin writes and dispatches restart only after response finish', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fraq-cli-webui-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'index.html'), '<main>CLI</main>');
  t.after(() => rm(root, { recursive: true, force: true }));
  const hono = new HonoService();
  const gateway = new WebuiGateway(hono, { accessToken: 'secret' }, root);
  const calls: Method[] = [];
  const client: ControlClient & { dispose(): void } = {
    async request(method) {
      calls.push(method);
      if (method === 'save') throw new ControlError('conflict', '配置已改变');
      if (method === 'status')
        return { session: 's', state: 'running', fallback: false, error: null, generation: 1, busy: false } as never;
      if (method === 'logs') return { session: 's', entries: [], cursor: 0, gap: false } as never;
      return { name: 'fraq.yml', format: 'yaml', content: '# raw', revision: '1' } as never;
    },
    dispose() {},
  };
  const service = new CliIntegrationService(client, () => {});
  t.after(() => service.dispose());
  gateway.mount('cli-integration', { assets: root, routes: (app) => service.routes(app) });
  assert.equal((await hono.app.request(`${base}/config`)).status, 401);
  assert.equal((await hono.app.request(`${base}/logs/stream`)).status, 401);
  assert.equal(calls.length, 0);
  const auth = await hono.app.request('/webui/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: 'secret' }),
  });
  const cookie = auth.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'http://localhost' };
  assert.equal((await hono.app.request(`${base}/config`, { headers })).status, 200);
  assert.equal(
    (
      await hono.app.request(`${base}/config`, {
        method: 'PUT',
        headers: { ...headers, Origin: 'http://attacker.invalid' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal((await hono.app.request(`${base}/config`, { method: 'PUT', headers, body: '{}' })).status, 400);
  const conflict = await hono.app.request(`${base}/config`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ content: '# draft', revision: 'old' }),
  });
  assert.equal(conflict.status, 409);

  const outgoing = new EventEmitter();
  const response = await hono.app.request(`${base}/restart`, { method: 'POST', headers }, { outgoing } as never);
  assert.equal(response.status, 202);
  assert.equal(calls.includes('restart'), false);
  outgoing.emit('finish');
  assert.equal(calls.includes('restart'), true);

  const stream = await hono.app.request(`${base}/logs/stream?after=0`, { headers });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body?.getReader();
  assert.ok(reader);
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: logs/);
  await reader.cancel();
});

test('does not mount a management page outside CLI watch mode', async () => {
  const { createMockContext } = await import('@fraqjs/plugin-mock');
  const { WebuiGatewayService } = await import('@fraqjs/plugin-webui-gateway');
  const { CliIntegrationPlugin } = await import('../src/index');
  const context = createMockContext();
  let mounts = 0;
  context.provide(
    WebuiGatewayService,
    new WebuiGatewayService(() => {
      mounts++;
    }),
  );
  context.install(CliIntegrationPlugin);
  try {
    await context.start();
    assert.equal(mounts, 0);
  } finally {
    await context.stop();
  }
});
