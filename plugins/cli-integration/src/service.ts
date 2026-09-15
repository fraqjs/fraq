import { type ControlClient, ControlError, type LogCursor, MAX_CONFIG_BYTES } from '@fraqjs/cli-protocol';
import { serviceToken } from '@fraqjs/kernel';
import type { WebuiEnv } from '@fraqjs/plugin-webui-gateway';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { createLogStream } from './logs';

import type { ServerResponse } from 'node:http';

const statusCodes = { invalid: 400, conflict: 409, busy: 409, unavailable: 503, timeout: 504, internal: 500 } as const;

export class CliIntegrationService {
  static readonly token = serviceToken<CliIntegrationService>('fraqjs/cli-integration/CliIntegrationService');
  private readonly streams = new Set<() => void>();
  constructor(
    private readonly client: ControlClient & { dispose(): void },
    private readonly reportError: (error: unknown) => void,
  ) {}

  routes(app: Hono<WebuiEnv>): void {
    app.use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        if (c.req.header('Origin') !== new URL(c.req.url).origin || c.req.header('Sec-Fetch-Site') === 'cross-site') {
          return c.json({ error: '仅允许同源操作。' }, 403);
        }
      }
      await next();
    });
    app.use('*', bodyLimit({ maxSize: MAX_CONFIG_BYTES * 6 + 1024 }));
    app.onError((error, c) => {
      const code = error instanceof ControlError ? error.code : 'internal';
      return c.json({ error: error.message, code }, statusCodes[code]);
    });
    app.get('/status', async (c) => c.json(await this.client.request('status', undefined)));
    app.get('/config', async (c) => c.json(await this.client.request('config', undefined)));
    app.put('/config', async (c) => {
      const input = (await c.req.json().catch(() => null)) as { content?: unknown; revision?: unknown } | null;
      if (!input || typeof input.content !== 'string' || typeof input.revision !== 'string') {
        throw new ControlError('invalid', '缺少配置内容或版本。');
      }
      return c.json(await this.client.request('save', { content: input.content, revision: input.revision }));
    });
    app.post('/restart', async (c) => {
      const status = await this.client.request('status', undefined);
      if (status.state === 'stopped') throw new ControlError('unavailable', '当前应用无法重启。');
      // Hono's Node adapter exposes the response. Dispatch only once the 202 has
      // actually been sent, since the restart will terminate this HTTP server.
      const outgoing = (c.env as { outgoing?: ServerResponse } | undefined)?.outgoing;
      if (!outgoing) throw new ControlError('unavailable', '当前 HTTP 服务不支持重启操作。');
      outgoing.once('finish', () => {
        void this.client.request('restart', undefined).catch(this.reportError);
      });
      return c.json({ accepted: true }, 202);
    });
    app.get('/logs/stream', (c) => {
      if (this.streams.size >= 8) return c.json({ error: '日志连接过多，请关闭其他页面后重试。' }, 429);
      const id = c.req.header('Last-Event-ID');
      const split = id?.lastIndexOf(':') ?? -1;
      const cursor: LogCursor = {
        session: split > 0 ? id?.slice(0, split) : c.req.query('session'),
        after: Number(split > 0 ? id?.slice(split + 1) : (c.req.query('after') ?? 0)),
      };
      if (!Number.isSafeInteger(cursor.after) || Number(cursor.after) < 0)
        throw new ControlError('invalid', '日志游标无效。');
      let close = () => {};
      const stream = createLogStream(this.client, cursor, {
        signal: c.req.raw.signal,
        expiresAt: c.get('webuiSession').expiresAt,
        onClose: () => this.streams.delete(close),
      });
      close = stream.close;
      this.streams.add(close);
      return new Response(stream.body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        },
      });
    });
  }

  dispose(): void {
    for (const close of this.streams) close();
    this.streams.clear();
    this.client.dispose();
  }
}
