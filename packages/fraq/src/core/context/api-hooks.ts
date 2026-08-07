import type { ContextState } from '@fraqjs/kernel';

import type { MilkyClient } from '../../protocol/client';
import type { AnyApiCall, AnyApiHook, ApiEndpointName, ApiHook } from '../../protocol/endpoint';

type InternalApiCall = {
  endpoint: ApiEndpointName;
  params: unknown;
};

type InternalApiNext = (params?: unknown) => Promise<unknown>;

type InternalApiHook = (params: unknown, next: InternalApiNext, call: InternalApiCall) => unknown | Promise<unknown>;

type ApiHookEntry = {
  endpoint?: ApiEndpointName;
  hook: InternalApiHook;
};

type CallApiCapable = {
  callApi(endpoint: string, params?: unknown): Promise<unknown>;
};

export class ApiHookRegistry {
  readonly client: MilkyClient;

  private readonly entries: ApiHookEntry[] = [];

  constructor(
    private readonly baseClient: MilkyClient,
    private readonly parent: ApiHookRegistry | undefined,
    private readonly contextName: string,
    private readonly getState: () => ContextState,
  ) {
    this.client = this.createHookClient();
  }

  register<E extends ApiEndpointName>(endpointOrHook: E | AnyApiHook, hook?: ApiHook<E>): () => void {
    const state = this.getState();
    if (state === 'stopping') {
      throw new Error(`Context "${this.contextName}" cannot register API hooks while it is stopping.`);
    }
    if (state === 'stopped') {
      throw new Error(`Context "${this.contextName}" cannot register API hooks after it has stopped.`);
    }

    let entry: ApiHookEntry;
    if (typeof endpointOrHook === 'function') {
      entry = {
        hook: (params, next, call) => {
          const apiCall = call as AnyApiCall;
          return endpointOrHook(apiCall, (nextParams = params) => next(nextParams));
        },
      };
    } else {
      if (!hook) {
        throw new Error(`API hook for endpoint ${endpointOrHook} is missing a handler.`);
      }
      entry = {
        endpoint: endpointOrHook,
        hook: hook as InternalApiHook,
      };
    }

    this.entries.push(entry);
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const index = this.entries.indexOf(entry);
      if (index !== -1) {
        this.entries.splice(index, 1);
      }
    };
  }

  clear(): void {
    this.entries.length = 0;
  }

  private createHookClient(): MilkyClient {
    return new Proxy(this.baseClient, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'string' && prop.includes('_')) {
          return (params?: unknown) => this.callHookedApi(prop as ApiEndpointName, params);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as MilkyClient;
  }

  private async callHookedApi(endpoint: ApiEndpointName, params?: unknown): Promise<unknown> {
    const hooks = this.collectApiHooks(endpoint);
    const dispatch = async (index: number, currentParams: unknown): Promise<unknown> => {
      const hook = hooks[index];
      if (!hook) {
        return await this.callBaseApi(endpoint, currentParams);
      }

      let nextCalled = false;
      return await hook(
        currentParams,
        async (nextParams = currentParams) => {
          if (nextCalled) {
            throw new Error(`API hook for endpoint ${endpoint} called next() multiple times.`);
          }
          nextCalled = true;
          return await dispatch(index + 1, nextParams);
        },
        {
          endpoint,
          params: currentParams,
        },
      );
    };

    return await dispatch(0, params);
  }

  private collectApiHooks(endpoint: ApiEndpointName): InternalApiHook[] {
    const hooks: InternalApiHook[] = [];
    let registry: ApiHookRegistry | undefined = this;
    while (registry) {
      for (const entry of registry.entries.toReversed()) {
        if (entry.endpoint === undefined || entry.endpoint === endpoint) {
          hooks.push(entry.hook);
        }
      }
      registry = registry.parent;
    }
    return hooks;
  }

  private async callBaseApi(endpoint: ApiEndpointName, params: unknown): Promise<unknown> {
    const callApi = (this.baseClient as Partial<CallApiCapable>).callApi;
    if (typeof callApi === 'function') {
      return await callApi.call(this.baseClient, endpoint, params);
    }

    const method = (this.baseClient as Record<string, unknown>)[endpoint];
    if (typeof method !== 'function') {
      throw new Error(`Milky client does not implement API endpoint ${endpoint}.`);
    }
    return await method.call(this.baseClient, params);
  }
}
