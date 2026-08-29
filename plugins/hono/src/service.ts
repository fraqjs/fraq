import { type Disposable, serviceToken } from '@fraqjs/kernel';
import { type HttpBindings, type ServerType, serve, upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

import type { AddressInfo } from 'node:net';

type ServeOptions = Parameters<typeof serve>[0];
type ExtraServeOptions = Omit<ServeOptions, 'fetch' | 'port' | 'hostname' | 'websocket'>;

export interface HonoServiceOptions {
  host?: string;
  port?: number;
  serveOptions?: ExtraServeOptions;
}

export class HonoService implements Disposable {
  static readonly token = serviceToken<HonoService>('fraqjs/hono/HonoService');

  readonly app = new Hono<{ Bindings: HttpBindings }>();
  readonly upgradeWebSocket = upgradeWebSocket;
  readonly host: string;
  readonly port: number;
  readonly serveOptions: ExtraServeOptions;

  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private server?: ServerType;

  constructor(options?: HonoServiceOptions) {
    this.host = options?.host ?? '127.0.0.1';
    this.port = options?.port ?? 4649; // 4 - F(our); 6 - R(oku); 4 - A; 9 - q.
    this.serveOptions = options?.serveOptions ?? {};
  }

  async listen(): Promise<AddressInfo> {
    if (this.server) {
      throw new Error('Server is already running');
    }

    return new Promise<AddressInfo>((resolve) => {
      this.server = serve(
        // @ts-expect-error
        {
          fetch: this.app.fetch,
          port: this.port,
          hostname: this.host,
          websocket: { server: this.webSocketServer },
          ...this.serveOptions,
        },
        (info) => {
          resolve(info);
        },
      );
    });
  }

  async dispose() {
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    this.webSocketServer.close();
  }
}

export { upgradeWebSocket };
