import { type ContextOf, defineContext } from '@fraqjs/kernel';
import mitt, { type Emitter } from 'mitt';

import { createMilkyClient, type MilkyClient } from '../../protocol/client';
import type { AnyApiHook, ApiEndpointName, ApiHook, EventMap } from '../../protocol/endpoint';
import { createMilkyWebSocketEventSource, type MilkyEventSource } from '../../protocol/event';
import { seg } from '../../protocol/segment';
import type { IncomingMessage, OutgoingSegment_ZodInput } from '../../protocol/types';
import type { Session } from '../../routing/command';
import { defaultRouteActivationResolver, type RouteActivationResolver, Router } from '../../routing/router';
import type { Filter } from '../filter';
import type { LogHandler } from '../logging';
import { ApiHookRegistry } from './api-hooks';
import { EventSourceRegistry } from './event-sources';
import { TimerRegistry } from './timers';

export interface ContextOptions {
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  /** @deprecated Subscribe to `context.logBus` instead. */
  logHandler?: LogHandler;
  routing?: {
    activationResolver?: RouteActivationResolver;
  };
}

export interface ContextUrlOptions {
  accessToken?: string;
  installEventSource?: boolean;
}

interface RootOptions {
  baseClient: MilkyClient;
  options?: ContextOptions;
}

interface Subsystems {
  readonly baseClient: MilkyClient;
  readonly eventBus: Emitter<EventMap>;
  readonly detachParentEvents: (() => void) | undefined;
  readonly apiHooks: ApiHookRegistry;
  readonly eventSources: EventSourceRegistry;
  readonly timers: TimerRegistry;
}

interface Builtins {
  readonly router: Router;
  readonly routeActivationResolver: RouteActivationResolver;
  readonly client: MilkyClient;
  on<K extends keyof EventMap>(type: K, handler: (event: EventMap[K]) => void | Promise<void>): () => void;
  installEventSource(eventSource: MilkyEventSource): void;
  hookApi: {
    <E extends ApiEndpointName>(endpoint: E, hook: ApiHook<E>): () => void;
    (hook: AnyApiHook): () => void;
  };
  timeout(delayMs: number, callback: () => void | Promise<void>): NodeJS.Timeout;
  interval(intervalMs: number, callback: () => void | Promise<void>): NodeJS.Timeout;
  createSession(selfId: number, message: IncomingMessage): Session;
}

function createSession(client: MilkyClient, selfId: number, message: IncomingMessage): Session {
  return {
    selfId,
    raw: message,
    reply: async (textOrSegments, options) => {
      const actualSegments: OutgoingSegment_ZodInput[] = [];
      if (typeof textOrSegments === 'string') {
        actualSegments.push({ type: 'text', data: { text: textOrSegments } });
      } else {
        actualSegments.push(...textOrSegments);
      }
      if (options?.withMention && message.message_scene === 'group') {
        actualSegments.unshift(seg.mention(message.sender_id));
      }
      if (options?.withQuote) {
        actualSegments.unshift(seg.reply(message.message_seq));
      }

      switch (message.message_scene) {
        case 'friend': {
          const { message_seq } = await client.send_private_message({
            user_id: message.peer_id,
            message: actualSegments,
          });
          return { messageSeq: message_seq };
        }
        case 'group': {
          const { message_seq } = await client.send_group_message({
            group_id: message.peer_id,
            message: actualSegments,
          });
          return { messageSeq: message_seq };
        }
      }
      return { messageSeq: 0 };
    },
    reaction: async (type, reactionId) => {
      if (message.message_scene === 'group') {
        await client.send_group_message_reaction({
          group_id: message.peer_id,
          message_seq: message.message_seq,
          reaction_type: type,
          reaction: reactionId,
        });
      }
    },
  };
}

const ContextRuntime = defineContext<RootOptions, Filter>()
  .subsystems<Subsystems>(({ name, logger, rootOptions, forkOptions, parent, getState, subsystem }) => {
    const baseClient = rootOptions?.baseClient ?? parent?.systems.baseClient;
    if (!baseClient) {
      throw new Error(`Sub context "${name}" does not have a parent client.`);
    }
    const eventBus = mitt<EventMap>();
    let detachParentEvents: (() => void) | undefined;
    if (parent) {
      const parentEventForwarder = <K extends keyof EventMap>(type: K, event: EventMap[K]) => {
        const predicate = forkOptions?.[type];
        if (forkOptions && predicate?.(event) !== true) {
          return;
        }
        eventBus.emit(type, event);
      };
      parent.systems.eventBus.on('*', parentEventForwarder);
      detachParentEvents = () => parent.systems.eventBus.off('*', parentEventForwarder);
    }

    const apiHooks = subsystem({
      name: 'apiHooks',
      create: () => new ApiHookRegistry(baseClient, parent?.systems.apiHooks, name, getState),
      stop: (registry) => registry.clear(),
    });
    const timers = subsystem({
      name: 'timers',
      create: () => new TimerRegistry(name, logger, getState),
      suspend: (registry) => registry.clear(),
    });
    const eventSources = subsystem({
      name: 'eventSources',
      create: () =>
        new EventSourceRegistry(rootOptions?.options?.reconnect, logger, getState, (event) => {
          eventBus.emit(event.event_type, event);
        }),
      activate: (registry) => registry.startAll(),
      deactivate: (registry) => registry.stop(),
    });

    return {
      baseClient,
      eventBus,
      detachParentEvents,
      apiHooks,
      eventSources,
      timers,
    };
  })
  .builtins<Builtins>(({ logger, rootOptions, parent, systems, getState }) => {
    const routeActivationResolver =
      rootOptions?.options?.routing?.activationResolver ??
      parent?.context.routeActivationResolver ??
      defaultRouteActivationResolver;
    return {
      router: new Router().setActivationResolver(routeActivationResolver),
      routeActivationResolver,
      client: systems.apiHooks.client,
      on<K extends keyof EventMap>(type: K, handler: (event: EventMap[K]) => void | Promise<void>): () => void {
        const wrappedHandler = async (event: EventMap[K]) => {
          try {
            const state = getState();
            if (state === 'stopping' || state === 'stopped') {
              return;
            }
            await handler(event);
          } catch (error) {
            logger.error(`Error handling event ${type}`, error);
          }
        };
        systems.eventBus.on(type, wrappedHandler);
        return () => systems.eventBus.off(type, wrappedHandler);
      },
      installEventSource: (eventSource) => systems.eventSources.install(eventSource),
      hookApi: (endpointOrHook: ApiEndpointName | AnyApiHook, hook?: ApiHook<ApiEndpointName>) =>
        systems.apiHooks.register(endpointOrHook, hook),
      timeout: (delayMs, callback) => systems.timers.timeout(delayMs, callback),
      interval: (intervalMs, callback) => systems.timers.interval(intervalMs, callback),
      createSession: (selfId, message) => createSession(systems.apiHooks.client, selfId, message),
    };
  })
  .plugins({
    create({ context, plugin }) {
      return { router: context.router.withMeta({ context: context.name, plugin: plugin.name }) };
    },
    applying({ context, plugin }) {
      let message = `Applying plugin ${plugin.name}`;
      const injectedServices = [
        ...Object.values(plugin.inject ?? {}).map((service) => service.name),
        ...Object.values(plugin.optionalInject ?? {}).map((token) => `${token.key}?`),
      ];
      const providedServices = (plugin.provides ?? []).map((service) => service.name);
      if (injectedServices.length > 0) {
        message += `, injects: [${injectedServices.join(', ')}]`;
      }
      if (providedServices.length > 0) {
        message += `, provides: [${providedServices.join(', ')}]`;
      }
      context.logger.info(message);
    },
    starting({ context, plugin }) {
      context.logger.debug(`Plugin ${plugin.name} is starting...`);
    },
  })
  .wire(({ context, systems }) => {
    const handleMessage = async ({ self_id, data: message }: EventMap['message_receive']) => {
      try {
        if (context.state === 'stopping' || context.state === 'stopped') {
          return;
        }
        await context.router.dispatch(context.createSession(self_id, message), message);
      } catch (error) {
        context.logger.error(
          `Error routing command (scene=${message.message_scene} peer=${message.peer_id} ` +
            `sender=${message.sender_id} seq=${message.message_seq})`,
          error,
        );
      }
    };
    systems.eventBus.on('message_receive', handleMessage);
    return () => {
      systems.eventBus.off('message_receive', handleMessage);
      systems.detachParentEvents?.();
    };
  })
  .build();

export type Context = ContextOf<typeof ContextRuntime>;

interface ContextConstructor {
  readonly prototype: Context;
  readonly [Symbol.hasInstance]: (value: unknown) => boolean;
  fromUrl(baseUrl: string | URL, options?: ContextOptions & ContextUrlOptions): Context;
  fromClient(client: MilkyClient, options?: ContextOptions): Context;
}

export const Context: ContextConstructor = Object.assign(ContextRuntime, {
  fromUrl(baseUrl: string | URL, options?: ContextOptions & ContextUrlOptions): Context {
    const client = createMilkyClient(baseUrl, { accessToken: options?.accessToken });
    const context = ContextRuntime.create({ baseClient: client, options });
    if (options?.logHandler) {
      context.logBus.on('log', options.logHandler);
    }
    if (options?.installEventSource ?? true) {
      context.installEventSource(createMilkyWebSocketEventSource(baseUrl, { accessToken: options?.accessToken }));
    }
    return context;
  },

  fromClient(client: MilkyClient, options?: ContextOptions): Context {
    const context = ContextRuntime.create({ baseClient: client, options });
    if (options?.logHandler) {
      context.logBus.on('log', options.logHandler);
    }
    const eventSourceLike = client as Partial<MilkyEventSource>;
    if (typeof eventSourceLike.start === 'function') {
      context.installEventSource(eventSourceLike as MilkyEventSource);
    }
    return context;
  },
});
