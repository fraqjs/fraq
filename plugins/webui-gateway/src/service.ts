import { serviceToken } from '@fraqjs/kernel';
import type { Hono } from 'hono';

import type { WebuiSession } from './authentication';

export type { WebuiSession } from './authentication';

export type WebuiEnv = {
  Variables: {
    webuiSession: WebuiSession;
  };
};

export interface WebuiMountOptions {
  assets: string | URL;
  entry?: string;
  routes?(app: Hono<WebuiEnv>): void;
}

export interface WebuiGatewayServiceOptions {
  accessToken: string;
  secureCookies?: boolean;
  sessionMaxAgeSeconds?: number;
}

export const WEBUI_BASE_PATH = '/webui';

export class WebuiGatewayService {
  static readonly token = serviceToken<WebuiGatewayService>('fraqjs/webui-gateway/WebuiGatewayService');

  constructor(private readonly mountWebui: (options: WebuiMountOptions) => void) {}

  mount(options: WebuiMountOptions): void {
    this.mountWebui(options);
  }
}
