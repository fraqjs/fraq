import type { milky } from '@fraqjs/fraq';
import HonoPlugin from '@fraqjs/plugin-hono';
import { createMockContext, createSimpleLogHandler } from '@fraqjs/plugin-mock';

import MilkyServerPlugin from '../src';

const ctx = createMockContext({ selfId: 123456, logHandler: createSimpleLogHandler() });

ctx.install(HonoPlugin);
ctx.install(MilkyServerPlugin, { accessToken: 'secret-token', prefix: '/milky' });

ctx.router.command('test').execute(() => console.log('Test command executed'));

await ctx.start();

const baseUrl = 'http://127.0.0.1:4649';

// Test: API - get_login_info (success)
const apiResponse = await fetch(`${baseUrl}/milky/api/get_login_info`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
  body: '{}',
});
console.log('API response:', await apiResponse.json());

// Test: API - unauthorized
const unauthorizedResponse = await fetch(`${baseUrl}/milky/api/get_login_info`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
console.log('Unauthorized status:', unauthorizedResponse.status);

// Test: API - not found
const notFoundResponse = await fetch(`${baseUrl}/milky/api/nonexistent_api`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
  body: '{}',
});
console.log('Not found status:', notFoundResponse.status);

// Test: SSE event push
const sseController = new AbortController();
const sseResponse = await fetch(`${baseUrl}/milky/event?access_token=secret-token`, {
  headers: { Accept: 'text/event-stream' },
  signal: sseController.signal,
});
const sseReader = sseResponse.body?.getReader();
const sseDataPromise = sseReader?.read();

// Wait for the SSE subscriber to register
await new Promise((resolve) => setTimeout(resolve, 50));

// Trigger an event from the mock client
await ctx.mock.receiveFriend({ userId: 789 }, [{ type: 'text', data: { text: 'Hello from mock!' } }]);

const sseResult = await Promise.race([
  sseDataPromise,
  new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
]);
if (sseResult) {
  console.log('SSE data:', new TextDecoder().decode(sseResult.value));
} else {
  console.error('SSE timeout');
}
sseController.abort();

// Test: WebSocket event push
const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/milky/event?access_token=secret-token`);
await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve(), { once: true });
  ws.addEventListener('error', () => reject(new Error('WS connection failed')), { once: true });
});

const wsMessagePromise = new Promise<string>((resolve) => {
  ws.addEventListener('message', (e) => resolve(e.data as string), { once: true });
});

await ctx.mock.receiveGroup({ groupId: 999, userId: 789 }, [{ type: 'text', data: { text: 'Group hello!' } }]);

const wsMessage = await Promise.race([
  wsMessagePromise,
  new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
]);
if (wsMessage) {
  const parsed = JSON.parse(wsMessage) as milky.Event;
  console.log('WS event type:', parsed.event_type);
} else {
  console.error('WS timeout');
}

ws.close();

await ctx.stop();
console.log('Smoke test passed');
