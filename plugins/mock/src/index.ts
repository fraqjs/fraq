import { Context, type ContextOptions, definePlugin, type MilkyClient } from '@fraqjs/fraq';

import { createSimpleLogHandler } from './logging';
import { MockService, type MockServiceOptions } from './service';

export interface MockPluginOptions extends MockServiceOptions {
  service?: MockService;
}

function installMock(ctx: Context, service: MockService): MockService {
  ctx.hookApi((call) => service.handleApiCall(call));
  ctx.installEventSource(service);
  ctx.provide(MockService, service);
  return service;
}

export const MockPlugin = definePlugin({
  name: 'mock',
  provides: [MockService],
  apply(ctx, options?: MockPluginOptions) {
    installMock(ctx, options?.service ?? new MockService(options));
  },
});

export type MockContext = Context & { readonly mock: MockService };

export interface MockContextOptions extends MockServiceOptions, ContextOptions {}

// installMock's hook handles every call, so this is never reached
const unreachableClient = new Proxy({} as MilkyClient, {
  get(_target, prop) {
    if (typeof prop === 'string' && prop.includes('_')) {
      return () => {
        throw new Error(`[plugin-mock] API "${prop}" fell through to the stub client.`);
      };
    }
    return undefined;
  },
});

export function createMockContext(options?: MockContextOptions): MockContext {
  const ctx = Context.fromClient(unreachableClient, {
    ...options,
    logHandler: options?.logHandler ?? createSimpleLogHandler(),
  });
  const mock = installMock(ctx, new MockService(options));
  return Object.assign(ctx, { mock }) as MockContext;
}

export * from './entity';
export * from './inbox';
export * from './logging';
export * from './message';
export * from './service';

export default MockPlugin;
