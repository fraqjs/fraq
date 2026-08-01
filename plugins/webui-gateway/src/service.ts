import type { Context } from 'hono';

import type { WebuiSession } from './authentication';

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

export class WebuiGatewayService {
  constructor(private readonly mountWebui: (options: WebuiMountOptions) => void) {}

  mount(options: WebuiMountOptions): void {
    this.mountWebui(options);
  }
}
