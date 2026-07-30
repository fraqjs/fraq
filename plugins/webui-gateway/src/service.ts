import type { HonoService } from '@fraqjs/plugin-hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';

import { WebuiAuthentication, type WebuiSession } from './authentication';

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type { WebuiSession } from './authentication';

type WebuiEnv = {
  Variables: {
    webuiSession: WebuiSession;
  };
};

export type WebuiContext = Context<WebuiEnv>;
export type WebuiHandler = (c: WebuiContext, session: WebuiSession) => Response | Promise<Response>;

export interface WebuiApi {
  get(path: string, handler: WebuiHandler): void;
  post(path: string, handler: WebuiHandler): void;
  put(path: string, handler: WebuiHandler): void;
  patch(path: string, handler: WebuiHandler): void;
  delete(path: string, handler: WebuiHandler): void;
}

export interface WebuiMountOptions {
  id: string;
  assets: string | URL;
  entry?: string;
  routes?(api: WebuiApi): void;
}

export interface WebuiGatewayServiceOptions {
  accessToken: string;
  secureCookies?: boolean;
  sessionMaxAgeSeconds?: number;
}

export const WEBUI_BASE_PATH = '/webui';

const WEBUI_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_WEBUI_IDS = new Set(['auth', 'login']);

export class WebuiGatewayService {
  private readonly authentication: WebuiAuthentication;
  private readonly mountedIds = new Set<string>();
  private readonly loginAssetsRoot: string;

  constructor(
    private readonly hono: HonoService,
    options: WebuiGatewayServiceOptions,
    loginAssetsRoot = fileURLToPath(new URL('../dist/webui', import.meta.url)),
  ) {
    this.loginAssetsRoot = loginAssetsRoot;
    this.authentication = new WebuiAuthentication(options.accessToken, {
      cookiePath: WEBUI_BASE_PATH,
      secureCookies: options.secureCookies,
      sessionMaxAgeSeconds: options.sessionMaxAgeSeconds,
    });
    this.registerGatewayRoutes();
  }

  mount(options: WebuiMountOptions): void {
    if (!WEBUI_ID_PATTERN.test(options.id) || RESERVED_WEBUI_IDS.has(options.id)) {
      throw new Error(
        `Invalid WebUI id "${options.id}". Use lowercase letters, numbers, and single hyphens between them.`,
      );
    }
    if (this.mountedIds.has(options.id)) {
      throw new Error(`WebUI "${options.id}" has already been mounted.`);
    }

    const assetsRoot = resolveAssetsRoot(options.assets);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(assetsRoot);
    } catch {
      throw new Error(`WebUI assets directory does not exist: ${assetsRoot}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`WebUI assets path is not a directory: ${assetsRoot}`);
    }

    const entry = normalizeEntry(options.entry ?? 'index.html');
    const mountPath = `${WEBUI_BASE_PATH}/${options.id}`;
    const app = new Hono<WebuiEnv>();

    app.use('*', async (c, next) => {
      setSecurityHeaders(c);
      const session = await this.authentication.getSession(c);
      if (!session) {
        if (c.req.path.startsWith(`${mountPath}/api/`) || c.req.path === `${mountPath}/api`) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const url = new URL(c.req.url);
        return c.redirect(`${WEBUI_BASE_PATH}/login/?returnTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
      }
      c.set('webuiSession', session);
      await next();
    });

    const api: WebuiApi = {
      get: (path, handler) => registerApiRoute(app, 'GET', path, handler),
      post: (path, handler) => registerApiRoute(app, 'POST', path, handler),
      put: (path, handler) => registerApiRoute(app, 'PUT', path, handler),
      patch: (path, handler) => registerApiRoute(app, 'PATCH', path, handler),
      delete: (path, handler) => registerApiRoute(app, 'DELETE', path, handler),
    };
    options.routes?.(api);

    app.use('*', async (c, next) => {
      c.header('Cache-Control', c.req.path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      await next();
    });
    app.use(
      '*',
      serveStatic({
        root: assetsRoot,
        rewriteRequestPath: (path) => path.slice(mountPath.length) || '/',
      }),
    );

    const serveEntry = serveStatic({ root: assetsRoot, path: entry });
    app.get('*', async (c, next) => {
      const relativePath = c.req.path.slice(mountPath.length);
      const acceptsHtml = c.req.header('Accept')?.includes('text/html') ?? false;
      const lastSegment = relativePath.split('/').at(-1) ?? '';
      if (!acceptsHtml || lastSegment.includes('.')) {
        return c.notFound();
      }
      c.header('Cache-Control', 'no-cache');
      return serveEntry(c, next);
    });

    this.hono.app.route(mountPath, app);
    this.mountedIds.add(options.id);
  }

  private registerGatewayRoutes(): void {
    const app = this.hono.app;
    const loginPath = `${WEBUI_BASE_PATH}/login`;

    app.use(`${loginPath}/*`, async (c, next) => {
      setSecurityHeaders(c);
      c.header('Cache-Control', c.req.path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
      await next();
    });

    app.get(loginPath, (c) => {
      const url = new URL(c.req.url);
      return c.redirect(`${loginPath}/${url.search}`);
    });
    app.get(`${loginPath}/`, async (c, next) => {
      const session = await this.authentication.getSession(c);
      if (session) {
        return c.redirect(this.resolveReturnTo(c.req.query('returnTo')));
      }
      await next();
    });
    app.use(
      `${loginPath}/*`,
      serveStatic({
        root: this.loginAssetsRoot,
        rewriteRequestPath: (path) => path.slice(loginPath.length) || '/',
      }),
    );

    app.post(`${WEBUI_BASE_PATH}/auth/login`, async (c) => {
      setSecurityHeaders(c);
      let body: { accessToken?: unknown; returnTo?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
      if (typeof body.accessToken !== 'string' || !this.authentication.verifyAccessToken(body.accessToken)) {
        return c.json({ error: 'Invalid access token' }, 401);
      }
      await this.authentication.createSession(c);
      return c.json({ redirectTo: this.resolveReturnTo(body.returnTo) });
    });

    app.post(`${WEBUI_BASE_PATH}/auth/logout`, (c) => {
      setSecurityHeaders(c);
      this.authentication.clearSession(c);
      return c.json({ ok: true });
    });

    app.get(`${WEBUI_BASE_PATH}/auth/session`, async (c) => {
      setSecurityHeaders(c);
      const session = await this.authentication.getSession(c);
      return c.json(
        session
          ? { authenticated: true, authenticatedAt: session.authenticatedAt, expiresAt: session.expiresAt }
          : { authenticated: false },
      );
    });

    app.get(WEBUI_BASE_PATH, (c) => c.redirect(`${WEBUI_BASE_PATH}/`));
    app.get(`${WEBUI_BASE_PATH}/`, async (c) => {
      setSecurityHeaders(c);
      const session = await this.authentication.getSession(c);
      if (!session) {
        return c.redirect(`${loginPath}/?returnTo=${encodeURIComponent(`${WEBUI_BASE_PATH}/`)}`);
      }
      const firstId = this.mountedIds.values().next().value;
      if (firstId) {
        return c.redirect(`${WEBUI_BASE_PATH}/${firstId}/`);
      }
      return c.json({ error: 'No WebUI is mounted' }, 404);
    });
  }

  private resolveReturnTo(value: unknown): string {
    const fallbackId = this.mountedIds.values().next().value;
    const fallback = fallbackId ? `${WEBUI_BASE_PATH}/${fallbackId}/` : `${WEBUI_BASE_PATH}/`;
    if (typeof value !== 'string' || !value.startsWith('/')) {
      return fallback;
    }
    try {
      const url = new URL(value, 'http://fraq.local');
      if (
        url.origin !== 'http://fraq.local' ||
        (url.pathname !== WEBUI_BASE_PATH && !url.pathname.startsWith(`${WEBUI_BASE_PATH}/`)) ||
        url.pathname === `${WEBUI_BASE_PATH}/login` ||
        url.pathname.startsWith(`${WEBUI_BASE_PATH}/login/`) ||
        url.pathname === `${WEBUI_BASE_PATH}/auth` ||
        url.pathname.startsWith(`${WEBUI_BASE_PATH}/auth/`)
      ) {
        return fallback;
      }
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return fallback;
    }
  }
}

function resolveAssetsRoot(assets: string | URL): string {
  if (assets instanceof URL) {
    if (assets.protocol !== 'file:') {
      throw new Error(`WebUI assets URL must use the file protocol: ${assets}`);
    }
    return fileURLToPath(assets);
  }
  return resolve(assets);
}

function normalizeEntry(entry: string): string {
  if (entry.length === 0 || isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
    throw new Error(`Invalid WebUI entry path: ${entry}`);
  }
  return entry;
}

function normalizeApiPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (normalized.includes('?') || normalized.includes('#') || normalized.split('/').includes('..')) {
    throw new Error(`Invalid WebUI API path: ${path}`);
  }
  return normalized;
}

function registerApiRoute(app: Hono<WebuiEnv>, method: string, path: string, handler: WebuiHandler): void {
  app.on(method, `/api${normalizeApiPath(path)}`, (c) => handler(c, c.get('webuiSession')));
}

function setSecurityHeaders(c: Context): void {
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
}
