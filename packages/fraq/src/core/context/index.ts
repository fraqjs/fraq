import mitt, { type WildcardHandler } from 'mitt';

import { createMilkyClient, type MilkyClient } from '../../protocol/client';
import type { AnyApiHook, ApiEndpointName, ApiHook, EventMap } from '../../protocol/endpoint';
import { createMilkyWebSocketEventSource, type MilkyEventSource } from '../../protocol/event';
import { seg } from '../../protocol/segment';
import type { IncomingMessage, OutgoingSegment_ZodInput } from '../../protocol/types';
import type { Session } from '../../routing/command';
import { type RouteActivationResolver, Router } from '../../routing/router';
import { type ContextRoutingOptions, createContextRouteActivationResolver } from '../activation';
import type { Filter } from '../filter';
import { Logger, type LogHandler } from '../logging';
import type { Injection, ParameterList, Plugin } from '../plugin';
import type { ServiceClass } from '../service';
import { ApiHookRegistry } from './api-hooks';
import { EventSourceRegistry } from './event-sources';
import { LifecycleManager } from './lifecycle';
import { PluginRegistry } from './plugins';
import { TimerRegistry } from './timers';

export interface ContextOptions {
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  logHandler?: LogHandler;
  routing?: ContextRoutingOptions;
}

export interface ContextUrlOptions {
  accessToken?: string;
  installEventSource?: boolean;
}

export class Context {
  readonly router = new Router();
  readonly logger: Logger;
  readonly name: string;
  readonly routeActivationResolver: RouteActivationResolver;
  readonly client: MilkyClient;

  private readonly baseClient: MilkyClient;
  private readonly parent?: Context;
  private readonly filter?: Filter;
  private readonly eventBus = mitt<EventMap>();
  private readonly subContexts = new Map<string, Context>();
  private readonly parentEventForwarder?: WildcardHandler<EventMap>;
  private readonly logHandler?: LogHandler;

  private readonly plugins: PluginRegistry;
  private readonly apiHooks: ApiHookRegistry;
  private readonly eventSources: EventSourceRegistry;
  private readonly timers: TimerRegistry;
  private readonly lifecycle: LifecycleManager;

  private constructor(
    baseClient: MilkyClient,
    options?: ContextOptions,
    name?: string,
    parent?: Context,
    filter?: Filter,
  ) {
    this.baseClient = baseClient;
    this.logHandler = options?.logHandler ?? parent?.logHandler;
    this.name = name ?? 'root';
    this.logger = new Logger((message) => this.logHandler?.(message), `context:${this.name}`);
    this.routeActivationResolver = createContextRouteActivationResolver(
      options?.routing,
      parent?.routeActivationResolver,
    );
    this.router.setActivationResolver(this.routeActivationResolver);

    this.parent = parent;
    this.filter = filter;
    if (parent) {
      this.parentEventForwarder = <K extends keyof EventMap>(type: K, event: EventMap[K]) => {
        if (this.filter) {
          const predicate = this.filter[type];
          if (predicate?.(event) !== true) {
            return;
          }
        }
        this.eventBus.emit(type, event);
      };
      parent.eventBus.on('*', this.parentEventForwarder);
    }

    const getState = () => this.lifecycle.state;
    this.plugins = new PluginRegistry(this, parent?.plugins, this.logHandler);
    this.apiHooks = new ApiHookRegistry(baseClient, parent?.apiHooks, this.name, getState);
    this.client = this.apiHooks.client;
    this.timers = new TimerRegistry(this.name, this.logger, getState);
    this.eventSources = new EventSourceRegistry(
      {
        initialReconnectDelayMs: options?.reconnect?.initialDelayMs,
        maxReconnectDelayMs: options?.reconnect?.maxDelayMs,
      },
      this.logger,
      getState,
      (event) => this.eventBus.emit(event.event_type, event),
    );
    this.lifecycle = new LifecycleManager(
      this.name,
      this.plugins,
      this.timers,
      this.eventSources,
      this.apiHooks,
      () => {
        if (this.parent && this.parentEventForwarder) {
          this.parent.eventBus.off('*', this.parentEventForwarder);
        }
      },
    );
    parent?.lifecycle.addChild(this.lifecycle);

    this.eventBus.on('message_receive', async ({ self_id, data: message }) => {
      try {
        if (this.lifecycle.state === 'stopping' || this.lifecycle.state === 'stopped') {
          return;
        }
        await this.router.dispatch(this.createSession(self_id, message), message);
      } catch (error) {
        this.logger.error(
          `Error routing command (scene=${message.message_scene} peer=${message.peer_id} sender=${message.sender_id} seq=${message.message_seq})`,
          error,
        );
      }
    });
  }

  on<K extends keyof EventMap>(type: K, handler: (event: EventMap[K]) => void | Promise<void>): () => void {
    const wrappedHandler = async (event: EventMap[K]) => {
      try {
        if (this.lifecycle.state === 'stopping' || this.lifecycle.state === 'stopped') {
          return;
        }
        await handler(event);
      } catch (error) {
        this.logger.error(`Error handling event ${type}`, error);
      }
    };
    this.eventBus.on(type, wrappedHandler);
    return () => {
      this.eventBus.off(type, wrappedHandler);
    };
  }

  install<T extends ParameterList, I extends Injection | undefined, OI extends Injection | undefined>(
    plugin: Plugin<T, I, OI>,
    ...args: T
  ): void {
    this.plugins.install(plugin, ...args);
  }

  installEventSource(eventSource: MilkyEventSource): void {
    this.eventSources.install(eventSource);
  }

  hookApi<E extends ApiEndpointName>(endpoint: E, hook: ApiHook<E>): () => void;
  hookApi(hook: AnyApiHook): () => void;
  hookApi<E extends ApiEndpointName>(endpointOrHook: E | AnyApiHook, hook?: ApiHook<E>): () => void {
    return this.apiHooks.register(endpointOrHook, hook);
  }

  provide<T extends object>(service: ServiceClass<T>, instance: T): void {
    this.plugins.provide(service, instance);
  }

  resolve<T extends object>(service: ServiceClass<T>): T {
    return this.plugins.resolve(service);
  }

  tryResolve<T extends object>(service: ServiceClass<T>): T | undefined {
    return this.plugins.tryResolve(service);
  }

  isProvided<T extends object>(service: ServiceClass<T>): boolean {
    return this.plugins.isProvided(service);
  }

  fork(name: string, filter?: Filter): Context {
    if (this.subContexts.has(name)) {
      if (filter) {
        throw new Error(
          `Sub context "${name}" already exists, so the provided filter cannot be applied. Please use fork('${name}') without a filter to get the existing subcontext.`,
        );
      }
      // biome-ignore lint/style/noNonNullAssertion: we just checked that the subcontext exists
      return this.subContexts.get(name)!;
    }
    const subContext = new Context(this.baseClient, undefined, name, this, filter);
    this.subContexts.set(name, subContext);
    return subContext;
  }

  timeout(delayMs: number, callback: () => void | Promise<void>): NodeJS.Timeout {
    return this.timers.timeout(delayMs, callback);
  }

  interval(intervalMs: number, callback: () => void | Promise<void>): NodeJS.Timeout {
    return this.timers.interval(intervalMs, callback);
  }

  createSession(selfId: number, message: IncomingMessage): Session {
    return {
      selfId,
      raw: message,
      reply: async (textOrSegments, options) => {
        const actualSegments: OutgoingSegment_ZodInput[] = [];
        if (typeof textOrSegments === 'string') {
          actualSegments.push({
            type: 'text',
            data: { text: textOrSegments },
          });
        } else {
          actualSegments.push(...textOrSegments);
        }
        if (options?.withMention && message.message_scene === 'group') {
          actualSegments.unshift(seg.mention(message.sender_id));
          // group: [mention, ...rest]
        }
        if (options?.withQuote) {
          actualSegments.unshift(seg.reply(message.message_seq));
          // friend: [reply, ...rest]
          // group: [reply, (mention,) ...rest]
        }

        switch (message.message_scene) {
          case 'friend': {
            const { message_seq } = await this.client.send_private_message({
              user_id: message.peer_id,
              message: actualSegments,
            });
            return { messageSeq: message_seq };
          }
          case 'group': {
            const { message_seq } = await this.client.send_group_message({
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
          await this.client.send_group_message_reaction({
            group_id: message.peer_id,
            message_seq: message.message_seq,
            reaction_type: type,
            reaction: reactionId,
          });
        }
      },
    };
  }

  async start(): Promise<void> {
    await this.lifecycle.start();
  }

  async stop(): Promise<void> {
    await this.lifecycle.stop();
  }

  static fromUrl(baseUrl: string | URL, options?: ContextOptions & ContextUrlOptions): Context {
    const client = createMilkyClient(baseUrl, { accessToken: options?.accessToken });
    const context = new Context(client, options);
    if (options?.installEventSource ?? true) {
      context.installEventSource(
        createMilkyWebSocketEventSource(baseUrl, {
          accessToken: options?.accessToken,
        }),
      );
    }
    return context;
  }

  static fromClient(client: MilkyClient, options?: ContextOptions): Context {
    const context = new Context(client, options);
    const eventSourceLike = client as Partial<MilkyEventSource>;
    if (typeof eventSourceLike.start === 'function') {
      context.installEventSource(eventSourceLike as MilkyEventSource);
    }
    return context;
  }
}
