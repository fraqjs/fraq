import mitt, { type WildcardHandler } from 'mitt';

import { createMilkyClient, type MilkyClient } from '../protocol/client';
import type { AnyApiCall, AnyApiHook, ApiEndpointName, ApiHook, EventMap } from '../protocol/endpoint';
import { createMilkyWebSocketEventSource, type MilkyEventSource, type MilkyEventSubscription } from '../protocol/event';
import { seg } from '../protocol/segment';
import type { Event, IncomingMessage, OutgoingSegment_ZodInput } from '../protocol/types';
import type { Session } from '../routing/command';
import { type RouteActivationResolver, Router } from '../routing/router';
import { type ContextRoutingOptions, createContextRouteActivationResolver } from './activation';
import type { Filter } from './filter';
import { Logger, type LogHandler } from './logging';
import type { Injection, ParameterList, Plugin } from './plugin';
import { implementsESNextDisposable, isDisposable, type ServiceClass } from './service';

const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

type ContextState = 'idle' | 'starting' | 'started' | 'stopping' | 'stopped';

type InstalledPlugin = {
  plugin: Plugin<ParameterList, Injection | undefined, Injection | undefined>;
  args: ParameterList;
  proxy?: Context;
};

type AppliedContextPlugins = {
  context: Context;
  sortedPlugins: InstalledPlugin[];
};

type EventSourceRuntime = {
  subscription?: MilkyEventSubscription;
  task?: Promise<void>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  resolveReconnectTimer?: () => void;
};

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
  private readonly plugins: InstalledPlugin[] = [];
  private readonly services = new Map<ServiceClass, object>();
  private readonly apiHookEntries: ApiHookEntry[] = [];
  private readonly subContexts = new Map<string, Context>();
  private readonly eventSourceRuntimes = new Map<MilkyEventSource, EventSourceRuntime>();
  private readonly parentEventForwarder?: WildcardHandler<EventMap>;
  private readonly timers = new Set<NodeJS.Timeout>();

  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly logHandler?: LogHandler;

  private state: ContextState = 'idle';
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;

  private constructor(
    baseClient: MilkyClient,
    options?: ContextOptions,
    name?: string,
    parent?: Context,
    filter?: Filter,
  ) {
    this.baseClient = baseClient;
    this.client = this.createHookClient();
    this.initialReconnectDelayMs = options?.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options?.reconnect?.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
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
    this.eventBus.on('message_receive', async ({ self_id, data: message }) => {
      try {
        if (this.state === 'stopping' || this.state === 'stopped') {
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
        if (this.state === 'stopping' || this.state === 'stopped') {
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
    this.plugins.push({ plugin: plugin as Plugin<ParameterList, Injection | undefined, Injection | undefined>, args });
  }

  installEventSource(eventSource: MilkyEventSource): void {
    if (this.eventSourceRuntimes.has(eventSource)) {
      return;
    }
    this.eventSourceRuntimes.set(eventSource, {});
    if (this.state === 'started') {
      this.startEventSource(eventSource);
    }
  }

  hookApi<E extends ApiEndpointName>(endpoint: E, hook: ApiHook<E>): () => void;
  hookApi(hook: AnyApiHook): () => void;
  hookApi<E extends ApiEndpointName>(endpointOrHook: E | AnyApiHook, hook?: ApiHook<E>): () => void {
    if (this.state === 'stopping') {
      throw new Error(`Context "${this.name}" cannot register API hooks while it is stopping.`);
    }
    if (this.state === 'stopped') {
      throw new Error(`Context "${this.name}" cannot register API hooks after it has stopped.`);
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

    this.apiHookEntries.push(entry);
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const index = this.apiHookEntries.indexOf(entry);
      if (index !== -1) {
        this.apiHookEntries.splice(index, 1);
      }
    };
  }

  provide<T extends object>(service: ServiceClass<T>, instance: T): void {
    if (this.services.has(service)) {
      throw new Error(`Service ${service.name} has already been provided in this context.`);
    }
    if (implementsESNextDisposable(instance) && !isDisposable(instance)) {
      throw new Error(
        `
Service ${service.name} implements ESNext Disposable but not Fraq Disposable.
Please explicitly import the interface like this:

import type { Disposable } from '@fraqjs/fraq';

and implement the dispose method to clean up resources when the context stops.
    `.trim(),
      );
    }
    this.services.set(service, instance);
  }

  resolve<T extends object>(service: ServiceClass<T>): T {
    const instance = this.tryResolve(service);
    if (instance === undefined) {
      throw new Error(`Service ${service.name} has not been provided.`);
    }
    return instance;
  }

  tryResolve<T extends object>(service: ServiceClass<T>): T | undefined {
    if (this.services.has(service)) {
      return this.services.get(service) as T;
    }
    return this.parent?.tryResolve(service);
  }

  isProvided<T extends object>(service: ServiceClass<T>): boolean {
    return this.tryResolve(service) !== undefined;
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
    this.assertCanScheduleTimer();
    const timeout = setTimeout(() => {
      this.timers.delete(timeout);
      void this.runTimerCallback(callback);
    }, delayMs);
    this.timers.add(timeout);
    return timeout;
  }

  interval(intervalMs: number, callback: () => void | Promise<void>): NodeJS.Timeout {
    this.assertCanScheduleTimer();
    const interval = setInterval(() => {
      void this.runTimerCallback(callback);
    }, intervalMs);
    this.timers.add(interval);
    return interval;
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
    if (this.state === 'started') {
      return;
    }
    if (this.state === 'starting') {
      await this.startPromise;
      return;
    }
    if (this.state === 'stopping') {
      throw new Error(`Context "${this.name}" cannot be started while it is stopping.`);
    }
    if (this.state === 'stopped') {
      throw new Error(`Context "${this.name}" cannot be restarted after it has been stopped.`);
    }

    this.state = 'starting';
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    if ((this.state === 'idle' && this.timers.size === 0) || this.state === 'stopped') {
      return;
    }
    let stateAfterStart: ContextState = this.state;
    if (stateAfterStart === 'starting') {
      await this.startPromise;
      // The awaited start or another stop call may have changed the state.
      stateAfterStart = this.state as ContextState;
    }
    if ((stateAfterStart === 'idle' && this.timers.size === 0) || stateAfterStart === 'stopped') {
      return;
    }
    if (stateAfterStart === 'stopping') {
      await this.stopPromise;
      return;
    }

    this.state = 'stopping';
    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.state = 'stopped';
      this.stopPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    const appliedContextPlugins: AppliedContextPlugins[] = [];
    const startingContexts: Context[] = [];
    try {
      await this.recursiveApplyPlugins(appliedContextPlugins, startingContexts);
      for (const { context, sortedPlugins } of appliedContextPlugins) {
        for (const installedPlugin of sortedPlugins) {
          const { plugin } = installedPlugin;
          if (!plugin.start) {
            continue;
          }
          context.logger.debug(`Plugin ${plugin.name} is starting...`);
          await plugin.start(context.getPluginContext(installedPlugin));
        }
      }
    } catch (error) {
      for (const context of startingContexts) {
        if (context.state === 'starting') {
          context.state = 'idle';
        }
      }
      throw error;
    }
    for (const { context } of appliedContextPlugins) {
      context.state = 'started';
      for (const eventSource of context.eventSourceRuntimes.keys()) {
        context.startEventSource(eventSource);
      }
    }
  }

  private async stopInternal(): Promise<void> {
    const errors: unknown[] = [];

    this.clearTimers();

    for (const subContext of [...this.subContexts.values()].reverse()) {
      try {
        await subContext.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    await this.stopEventSources(errors);

    if (this.parent && this.parentEventForwarder) {
      this.parent.eventBus.off('*', this.parentEventForwarder);
    }

    for (const service of [...this.services.values()].reverse()) {
      if (!isDisposable(service)) {
        continue;
      }
      try {
        await service.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    this.apiHookEntries.length = 0;

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `Context "${this.name}" failed to stop cleanly.`);
    }
  }

  private assertCanScheduleTimer(): void {
    if (this.state === 'stopping') {
      throw new Error(`Context "${this.name}" cannot schedule timers while it is stopping.`);
    }
    if (this.state === 'stopped') {
      throw new Error(`Context "${this.name}" cannot schedule timers after it has stopped.`);
    }
  }

  private async runTimerCallback(callback: () => void | Promise<void>): Promise<void> {
    if (this.state === 'stopping' || this.state === 'stopped') {
      return;
    }
    try {
      await callback();
    } catch (error) {
      this.logger.error('Error handling timer callback', error);
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private async stopEventSources(errors: unknown[]): Promise<void> {
    for (const [_, runtime] of this.eventSourceRuntimes) {
      this.resolveReconnectDelay(runtime);
      const subscription = runtime.subscription;
      if (!subscription) {
        continue;
      }
      try {
        await subscription.stop();
      } catch (error) {
        errors.push(error);
      }
      runtime.subscription = undefined;
    }
    for (const runtime of this.eventSourceRuntimes.values()) {
      if (!runtime.task) {
        continue;
      }
      try {
        await runtime.task;
      } catch (error) {
        errors.push(error);
      } finally {
        runtime.task = undefined;
      }
    }
  }

  private async applyPlugins(sortedPlugins: InstalledPlugin[]): Promise<void> {
    for (const installedPlugin of sortedPlugins) {
      const { plugin, args } = installedPlugin;
      const providedBeforeApply = new Set(this.services.keys());
      let applyingMessage = `Applying plugin ${plugin.name}`;
      const requiredServices: string[] = [];
      const providedServices: string[] = [];
      if (plugin.requires) {
        for (const service of plugin.requires) {
          requiredServices.push(service.name);
        }
      }
      if (plugin.optionalRequires) {
        for (const service of plugin.optionalRequires) {
          requiredServices.push(`${service.name}?`);
        }
      }
      if (plugin.provides) {
        for (const service of plugin.provides) {
          providedServices.push(service.name);
        }
      }
      if (requiredServices.length > 0) {
        applyingMessage += `, requires: [${requiredServices.join(', ')}]`;
      }
      if (providedServices.length > 0) {
        applyingMessage += `, provides: [${providedServices.join(', ')}]`;
      }
      this.logger.info(applyingMessage);
      await plugin.apply(this.getPluginContext(installedPlugin), ...args);
      for (const service of plugin.provides ?? []) {
        if (!this.services.has(service) || providedBeforeApply.has(service)) {
          throw new Error(`${plugin.name} declares service ${service.name} but did not provide it.`);
        }
      }
    }
  }

  private async recursiveApplyPlugins(
    appliedContextPlugins: AppliedContextPlugins[],
    startingContexts: Context[],
  ): Promise<void> {
    if (this.state === 'started') {
      return;
    }
    if (this.state === 'starting' && this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.state === 'stopping') {
      throw new Error(`Context "${this.name}" cannot be started while it is stopping.`);
    }
    if (this.state === 'stopped') {
      throw new Error(`Context "${this.name}" cannot be restarted after it has been stopped.`);
    }
    if (this.state === 'idle') {
      this.state = 'starting';
    }
    startingContexts.push(this);

    const sortedPlugins = this.sortPlugins();
    await this.applyPlugins(sortedPlugins);
    appliedContextPlugins.push({ context: this, sortedPlugins });

    for (const subContext of this.subContexts.values()) {
      await subContext.recursiveApplyPlugins(appliedContextPlugins, startingContexts);
    }
  }

  private sortPlugins(): InstalledPlugin[] {
    // validate that no service is provided by multiple plugins
    const providers = new Map<ServiceClass, Plugin<ParameterList, Injection | undefined, Injection | undefined>>();
    for (const { plugin } of this.plugins) {
      for (const service of plugin.provides ?? []) {
        const existingProvider = providers.get(service);
        if (existingProvider) {
          throw new Error(
            `Service ${service.name} is declared by multiple plugins: ${existingProvider.name} and ${plugin.name}.`,
          );
        }
        providers.set(service, plugin);
      }
    }

    const pending = [...this.plugins];
    const sorted: InstalledPlugin[] = [];
    const available = new Set<ServiceClass>();
    for (const service of this.collectAvailableServices()) {
      available.add(service);
    }

    while (pending.length > 0) {
      const availableByPendingPlugins = this.collectPendingProvidedServices(pending);
      const requiredReadyIndex = pending.findIndex(({ plugin }) =>
        this.areRequiredServicesAvailable(plugin, available),
      );
      const optionalReadyIndex = pending.findIndex(
        ({ plugin }) =>
          this.areRequiredServicesAvailable(plugin, available) &&
          this.areOptionalServicesReady(plugin, available, availableByPendingPlugins),
      );
      const nextIndex = optionalReadyIndex === -1 ? requiredReadyIndex : optionalReadyIndex;
      if (nextIndex === -1) {
        throw this.createUnresolvablePluginError(pending, available);
      }

      const [next] = pending.splice(nextIndex, 1);
      sorted.push(next);
      for (const service of next.plugin.provides ?? []) {
        available.add(service);
      }
    }

    return sorted;
  }

  private collectPendingProvidedServices(pending: InstalledPlugin[]): Map<ServiceClass, InstalledPlugin> {
    const providedServices = new Map<ServiceClass, InstalledPlugin>();
    for (const installedPlugin of pending) {
      for (const service of installedPlugin.plugin.provides ?? []) {
        providedServices.set(service, installedPlugin);
      }
    }
    return providedServices;
  }

  private areRequiredServicesAvailable(
    plugin: Plugin<ParameterList, Injection | undefined, Injection | undefined>,
    available: Set<ServiceClass>,
  ): boolean {
    return (plugin.requires ?? []).every((service) => available.has(service));
  }

  private areOptionalServicesReady(
    plugin: Plugin<ParameterList, Injection | undefined, Injection | undefined>,
    available: Set<ServiceClass>,
    pendingProviders: Map<ServiceClass, InstalledPlugin>,
  ): boolean {
    return (plugin.optionalRequires ?? []).every((service) => {
      if (available.has(service)) {
        return true;
      }
      const pendingProvider = pendingProviders.get(service);
      return pendingProvider === undefined || pendingProvider.plugin === plugin;
    });
  }

  private collectAvailableServices(): ServiceClass[] {
    const services = [...this.services.keys()];
    if (this.parent) {
      services.push(...this.parent.collectAvailableServices());
    }
    return services;
  }

  private createUnresolvablePluginError(pending: InstalledPlugin[], available: Set<ServiceClass>): Error {
    const missingRequirements = new Map<
      ServiceClass,
      Plugin<ParameterList, Injection | undefined, Injection | undefined>[]
    >();
    const pendingProviders = new Set<ServiceClass>();
    for (const { plugin } of pending) {
      for (const service of plugin.provides ?? []) {
        pendingProviders.add(service);
      }
    }

    for (const { plugin } of pending) {
      for (const service of plugin.requires ?? []) {
        if (!available.has(service)) {
          const plugins = missingRequirements.get(service) ?? [];
          plugins.push(plugin);
          missingRequirements.set(service, plugins);
        }
      }
    }

    const lines = [...missingRequirements].map(([service, plugins]) => {
      const dependents = plugins.map((plugin) => plugin.name).join(', ');
      const reason = pendingProviders.has(service)
        ? 'blocked by a dependency cycle'
        : 'no installed plugin provides it';
      return `${service.name} required by ${dependents} (${reason})`;
    });

    return new Error(`Unable to resolve plugin service dependencies: ${lines.join('; ')}.`);
  }

  private getPluginContext(installedPlugin: InstalledPlugin): Context {
    installedPlugin.proxy ??= this.createProxyContextForPlugin(installedPlugin.plugin);
    return installedPlugin.proxy;
  }

  private createProxyContextForPlugin(
    plugin: Plugin<ParameterList, Injection | undefined, Injection | undefined>,
  ): Context {
    // Proxied logger with plugin name as prefix
    const proxyLogger = new Logger(
      (message) => this.logHandler?.(message),
      `plugin:${this.name ? `${this.name}/` : ''}${plugin.name}`,
    );
    const proxyRouter = this.router.withMeta({
      context: this.name,
      plugin: plugin.name,
    });

    let proxyInjections: undefined | Record<string, object | undefined>;
    if (plugin.inject) {
      proxyInjections = {};
      for (const [key, service] of Object.entries(plugin.inject)) {
        proxyInjections[key] = this.resolve(service);
      }
    }
    if (plugin.optionalInject) {
      proxyInjections ??= {};
      for (const [key, service] of Object.entries(plugin.optionalInject)) {
        proxyInjections[key] = this.tryResolve(service);
      }
    }

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === 'logger') {
          return proxyLogger;
        } else if (prop === 'router') {
          return proxyRouter;
        } else if (proxyInjections && prop in proxyInjections) {
          return proxyInjections[prop as keyof typeof proxyInjections];
        } else {
          return Reflect.get(target, prop, receiver);
        }
      },
    });
  }

  private startEventSource(eventSource: MilkyEventSource): void {
    const runtime = this.eventSourceRuntimes.get(eventSource);
    if (!runtime) {
      return;
    }
    runtime.task = this.runEventSource(eventSource, runtime);
  }

  private async runEventSource(eventSource: MilkyEventSource, runtime: EventSourceRuntime): Promise<void> {
    let reconnectDelay = this.initialReconnectDelayMs;
    let reconnectAttempt = 1;
    while (this.state === 'started') {
      try {
        this.logger.debug(`Connecting ${eventSource.name ?? 'event source'} (attempt=${reconnectAttempt})`);
        const subscription = await eventSource.start((event: Event) => {
          try {
            if (this.state !== 'started') {
              return;
            }
            this.eventBus.emit(event.event_type, event);
          } catch (error) {
            this.logger.error('Error handling event stream event', error);
          }
        });
        if (this.state !== 'started') {
          await subscription.stop();
          break;
        }
        runtime.subscription = subscription;
        this.logger.info(`${eventSource.name ?? 'Event source'} connected`);
        reconnectDelay = this.initialReconnectDelayMs;
        reconnectAttempt = 1;
        await subscription.closed;
        if (runtime.subscription === subscription) {
          runtime.subscription = undefined;
        }
        if (this.state !== 'started') {
          break;
        }
        this.logger.warn(`${eventSource.name ?? 'Event source'} disconnected; reconnecting in ${reconnectDelay}ms`);
      } catch (error) {
        if (this.state !== 'started') {
          break;
        }
        this.logger.error(
          `Error connecting ${eventSource.name ?? 'event source'}; reconnecting in ${reconnectDelay}ms`,
          error,
        );
      }
      await this.waitForReconnectDelay(runtime, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, this.maxReconnectDelayMs);
      reconnectAttempt += 1;
    }
  }

  private waitForReconnectDelay(runtime: EventSourceRuntime, delay: number): Promise<void> {
    return new Promise((resolve) => {
      runtime.resolveReconnectTimer = resolve;
      runtime.reconnectTimer = setTimeout(() => {
        runtime.reconnectTimer = undefined;
        runtime.resolveReconnectTimer = undefined;
        resolve();
      }, delay);
    });
  }

  private resolveReconnectDelay(runtime: EventSourceRuntime): void {
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = undefined;
    }
    const resolve = runtime.resolveReconnectTimer;
    runtime.resolveReconnectTimer = undefined;
    resolve?.();
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
    let context: Context | undefined = this;
    while (context) {
      for (const entry of context.apiHookEntries.toReversed()) {
        if (entry.endpoint === undefined || entry.endpoint === endpoint) {
          hooks.push(entry.hook);
        }
      }
      context = context.parent;
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
