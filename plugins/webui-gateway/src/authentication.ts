import type { Context } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';

import { createHash, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'fraq_webui_session';

export interface WebuiSession {
  authenticatedAt: number;
  expiresAt: number;
}

export interface AuthenticationOptions {
  accessToken: string;
  cookiePath: string;
  secureCookies?: boolean;
  sessionMaxAgeSeconds?: number;
}

export class WebuiAuthentication {
  private readonly accessTokenDigest: Buffer;
  private readonly cookiePath: string;
  private readonly secureCookies: boolean;
  private readonly sessionMaxAgeSeconds: number;

  constructor(
    private readonly accessToken: string,
    options: Omit<AuthenticationOptions, 'accessToken'>,
  ) {
    if (accessToken.length === 0) {
      throw new Error('WebUI gateway accessToken must not be empty.');
    }
    if (options.sessionMaxAgeSeconds !== undefined && options.sessionMaxAgeSeconds <= 0) {
      throw new Error('WebUI gateway sessionMaxAgeSeconds must be greater than zero.');
    }

    this.accessTokenDigest = createHash('sha256').update(accessToken).digest();
    this.cookiePath = options.cookiePath;
    this.secureCookies = options.secureCookies ?? false;
    this.sessionMaxAgeSeconds = options.sessionMaxAgeSeconds ?? 7 * 24 * 60 * 60;
  }

  verifyAccessToken(candidate: string): boolean {
    const candidateDigest = createHash('sha256').update(candidate).digest();
    return timingSafeEqual(this.accessTokenDigest, candidateDigest);
  }

  async getSession(c: Context): Promise<WebuiSession | undefined> {
    const value = await getSignedCookie(c, this.accessToken, COOKIE_NAME);
    if (!value || typeof value !== 'string') {
      return undefined;
    }

    const [version, authenticatedAtRaw, expiresAtRaw] = value.split(':');
    const authenticatedAt = Number(authenticatedAtRaw);
    const expiresAt = Number(expiresAtRaw);
    if (
      version !== 'v1' ||
      !Number.isSafeInteger(authenticatedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      return undefined;
    }
    return { authenticatedAt, expiresAt };
  }

  async createSession(c: Context): Promise<WebuiSession> {
    const authenticatedAt = Date.now();
    const expiresAt = authenticatedAt + this.sessionMaxAgeSeconds * 1000;
    await setSignedCookie(c, COOKIE_NAME, `v1:${authenticatedAt}:${expiresAt}`, this.accessToken, {
      httpOnly: true,
      maxAge: this.sessionMaxAgeSeconds,
      path: this.cookiePath,
      sameSite: 'Lax',
      secure: this.secureCookies,
    });
    return { authenticatedAt, expiresAt };
  }

  clearSession(c: Context): void {
    deleteCookie(c, COOKIE_NAME, {
      path: this.cookiePath,
      secure: this.secureCookies,
    });
  }
}
