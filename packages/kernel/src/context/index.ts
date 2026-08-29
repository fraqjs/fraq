/** biome-ignore-all lint/style/noNonNullAssertion: Safe enough since the builder is only used after the subsystems and builtins are defined. */
import type { Emitter } from 'mitt';

import { createLogEmitter, type LogEmitter, type LogEvents, Logger } from '../logging';
import type { ParameterList, PluginDefinition } from '../plugin';
import type { ScopedServiceFactory, ServiceClass, ServiceIdentifier, ServiceToken } from '../service';
import { type ContextState, LifecycleManager } from './lifecycle';
import { PluginRegistry, type PluginRegistryOptions } from './plugins';
import { ServiceRegistry, type ServiceResolutionScope } from './services';
import { type SubsystemDefinition, SubsystemRegistry } from './subsystems';
import { TimerRegistry } from './timers';

export type { ContextState } from './lifecycle';
export type { SubsystemCleanupResult, SubsystemDefinition, SubsystemHooks } from './subsystems';

export interface KernelContext<C extends object, ForkOptions> {
  readonly name: string;
  readonly path: readonly string[];
  readonly state: ContextState;
  readonly logger: Logger;
  readonly logBus: LogEmitter;
  timeout(delayMs: number, callback: () => void | Promise<void>): NodeJS.Timeout;
  interval(intervalMs: number, callback: () => void | Promise<void>): NodeJS.Timeout;

  install<T extends ParameterList>(plugin: PluginDefinition<C, T>, ...args: T): void;

  provide<T extends object>(service: ServiceClass<T>, instance: T): void;
  provide<T extends object>(service: ServiceClass<T>, factory: ScopedServiceFactory<T, C>): void;
  resolve<T extends object>(service: ServiceClass<T>): T;
  resolve<T extends object>(token: ServiceToken<T>): T;
  tryResolve<T extends object>(service: ServiceClass<T>): T | undefined;
  tryResolve<T extends object>(token: ServiceToken<T>): T | undefined;
  isProvided<T extends object>(service: ServiceClass<T>): boolean;
  isProvided<T extends object>(token: ServiceToken<T>): boolean;

  fork(name: string, options?: ForkOptions): C;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type ContextInstance<Builtins extends object, ForkOptions> = KernelContext<
  ContextInstance<Builtins, ForkOptions>,
  ForkOptions
> &
  Readonly<Builtins>;

export interface ContextClass<RootOptions, ForkOptions, Builtins extends object> {
  readonly prototype: ContextInstance<Builtins, ForkOptions>;
  readonly [Symbol.hasInstance]: (value: unknown) => boolean;
  create(options: RootOptions): ContextInstance<Builtins, ForkOptions>;
}

export type ContextOf<T> =
  T extends ContextClass<infer _RootOptions, infer ForkOptions, infer Builtins>
    ? ContextInstance<Builtins, ForkOptions>
    : never;

interface ParentSystems<Subsystems> {
  readonly systems: Subsystems;
}

interface ParentContext<Subsystems, Builtins extends object, ForkOptions> extends ParentSystems<Subsystems> {
  readonly context: ContextInstance<Builtins, ForkOptions>;
}

type SubsystemFactory<RootOptions, ForkOptions, Subsystems> = (assembly: {
  readonly name: string;
  readonly path: readonly string[];
  readonly logger: Logger;
  readonly rootOptions: RootOptions | undefined;
  readonly forkOptions: ForkOptions | undefined;
  readonly parent: ParentSystems<Subsystems> | undefined;
  readonly getState: () => ContextState;
  subsystem<T>(definition: SubsystemDefinition<T>): T;
}) => Subsystems;

type BuiltinFactory<RootOptions, ForkOptions, Subsystems, Builtins extends object> = (assembly: {
  readonly name: string;
  readonly path: readonly string[];
  readonly logger: Logger;
  readonly rootOptions: RootOptions | undefined;
  readonly forkOptions: ForkOptions | undefined;
  readonly parent: ParentContext<Subsystems, Builtins, ForkOptions> | undefined;
  readonly systems: Subsystems;
  readonly getState: () => ContextState;
}) => Builtins;

export interface PluginContextOptions<Subsystems, Builtins extends object, ForkOptions> {
  create?(assembly: PluginContextAssembly<Subsystems, Builtins, ForkOptions>): object | undefined;
  applying?(assembly: PluginContextAssembly<Subsystems, Builtins, ForkOptions>): void;
  starting?(assembly: PluginContextAssembly<Subsystems, Builtins, ForkOptions>): void;
}

export interface ContextWiring<Subsystems, Builtins extends object, ForkOptions> {
  readonly context: ContextInstance<Builtins, ForkOptions>;
  readonly systems: Subsystems;
}

export interface PluginContextAssembly<Subsystems, Builtins extends object, ForkOptions>
  extends ContextWiring<Subsystems, Builtins, ForkOptions> {
  readonly plugin: PluginDefinition<ContextInstance<Builtins, ForkOptions>, ParameterList>;
}

type Wire<Subsystems, Builtins extends object, ForkOptions> = (
  wiring: ContextWiring<Subsystems, Builtins, ForkOptions>,
) => void | (() => void | Promise<void>);

export class ContextBuilder<RootOptions, ForkOptions, Subsystems = never, Builtins extends object = never> {
  private wireContext?: Wire<Subsystems, Builtins, ForkOptions>;
  private pluginContextOptions: PluginContextOptions<Subsystems, Builtins, ForkOptions> = {};

  constructor(
    private readonly createSubsystems?: SubsystemFactory<RootOptions, ForkOptions, Subsystems>,
    private readonly createBuiltins?: BuiltinFactory<RootOptions, ForkOptions, Subsystems, Builtins>,
  ) {}

  subsystems<NextSubsystems>(
    this: [Subsystems] extends [never] ? ContextBuilder<RootOptions, ForkOptions> : never,
    create: SubsystemFactory<RootOptions, ForkOptions, NextSubsystems>,
  ): ContextBuilder<RootOptions, ForkOptions, NextSubsystems> {
    return new ContextBuilder(create);
  }

  builtins<NextBuiltins extends object>(
    this: [Subsystems] extends [never]
      ? never
      : [Builtins] extends [never]
        ? ContextBuilder<RootOptions, ForkOptions, Subsystems>
        : never,
    create: BuiltinFactory<RootOptions, ForkOptions, Subsystems, NextBuiltins>,
  ): ContextBuilder<RootOptions, ForkOptions, Subsystems, NextBuiltins> {
    return new ContextBuilder(this.createSubsystems, create);
  }

  plugins(
    this: [Builtins] extends [never] ? never : ContextBuilder<RootOptions, ForkOptions, Subsystems, Builtins>,
    options: PluginContextOptions<Subsystems, Builtins, ForkOptions>,
  ): ContextBuilder<RootOptions, ForkOptions, Subsystems, Builtins> {
    this.pluginContextOptions = options;
    return this;
  }

  wire(
    this: [Builtins] extends [never] ? never : ContextBuilder<RootOptions, ForkOptions, Subsystems, Builtins>,
    wire: Wire<Subsystems, Builtins, ForkOptions>,
  ): ContextBuilder<RootOptions, ForkOptions, Subsystems, Builtins> {
    this.wireContext = wire;
    return this;
  }

  build(
    this: [Builtins] extends [never] ? never : ContextBuilder<RootOptions, ForkOptions, Subsystems, Builtins>,
  ): ContextClass<RootOptions, ForkOptions, Builtins> {
    type Context = ContextInstance<Builtins, ForkOptions>;
    const createSubsystems = this.createSubsystems!;
    const createBuiltins = this.createBuiltins!;
    const wireContext = this.wireContext;
    const pluginContextOptions = this.pluginContextOptions;

    class RuntimeContext {
      static create(options: RootOptions): Context {
        return new RuntimeContext('root', options) as unknown as Context;
      }

      readonly name: string;
      readonly path: readonly string[];

      private readonly children = new Map<string, RuntimeContext>();
      private readonly logEvents: Emitter<LogEvents>;
      readonly logger: Logger;
      readonly logBus: LogEmitter;
      private readonly services: ServiceRegistry<Context>;
      private readonly serviceScope: ServiceResolutionScope<Context>;
      private readonly subsystems = new SubsystemRegistry();
      private readonly timers: TimerRegistry;
      private readonly systems: Subsystems;
      private readonly plugins: PluginRegistry<Context>;
      private readonly lifecycle: LifecycleManager<Context>;
      private unwire?: () => void | Promise<void>;

      private constructor(
        name: string,
        rootOptions: RootOptions | undefined,
        forkOptions?: ForkOptions,
        parent?: RuntimeContext,
      ) {
        this.name = name;
        this.path = Object.freeze([...(parent?.path ?? []), name]);
        this.logEvents = parent?.logEvents ?? createLogEmitter();
        this.logBus = parent?.logBus ?? {
          on: (type, handler) => this.logEvents.on(type, handler),
          off: (type, handler) => this.logEvents.off(type, handler),
        };
        this.logger = new Logger((message) => this.logEvents.emit('log', message), `context:${name}`);
        this.services = new ServiceRegistry(parent?.services);

        const getState = () => this.lifecycle.state;
        this.timers = this.subsystems.register({
          name: 'timers',
          create: () => new TimerRegistry(name, this.logger, getState),
          suspend: (timers) => timers.clear(),
        });
        this.systems = createSubsystems({
          name,
          path: this.path,
          logger: this.logger,
          rootOptions,
          forkOptions,
          parent: parent ? { systems: parent.systems } : undefined,
          getState,
          subsystem: (definition) => this.subsystems.register(definition),
        });
        const builtins = createBuiltins({
          name,
          path: this.path,
          logger: this.logger,
          rootOptions,
          forkOptions,
          parent: parent ? { context: parent as unknown as Context, systems: parent.systems } : undefined,
          systems: this.systems,
          getState,
        });
        for (const key of Reflect.ownKeys(builtins)) {
          if (key in this) {
            throw new Error(`Builtin ${String(key)} conflicts with the Kernel Context API.`);
          }
        }
        Object.assign(this, builtins);

        const context = this as unknown as Context;
        this.serviceScope = { key: this, value: { context, contextPath: this.path } };
        const registryOptions: PluginRegistryOptions<Context> = {
          createContextProperties: (_context, plugin) => ({
            ...(pluginContextOptions.create?.({ context, systems: this.systems, plugin }) ?? {}),
            logger: new Logger(
              (message) => this.logEvents.emit('log', message),
              `plugin:${context.name ? `${context.name}/` : ''}${plugin.name}`,
            ),
          }),
          applying: pluginContextOptions.applying
            ? (_context, plugin) => pluginContextOptions.applying?.({ context, systems: this.systems, plugin })
            : undefined,
          starting: pluginContextOptions.starting
            ? (_context, plugin) => pluginContextOptions.starting?.({ context, systems: this.systems, plugin })
            : undefined,
        };
        this.plugins = new PluginRegistry(context, this.services, this.path, registryOptions);
        this.lifecycle = new LifecycleManager(name, this.plugins, this.services, this.subsystems, async () => {
          await this.unwire?.();
          this.unwire = undefined;
        });
        parent?.lifecycle.addChild(this.lifecycle);
        this.unwire = wireContext?.({ context, systems: this.systems }) ?? undefined;
      }

      get state(): ContextState {
        return this.lifecycle.state;
      }

      timeout(delayMs: number, callback: () => void | Promise<void>): NodeJS.Timeout {
        return this.timers.timeout(delayMs, callback);
      }

      interval(intervalMs: number, callback: () => void | Promise<void>): NodeJS.Timeout {
        return this.timers.interval(intervalMs, callback);
      }

      install<T extends ParameterList>(plugin: PluginDefinition<Context, T>, ...args: T): void {
        this.plugins.install(plugin, ...args);
      }

      provide<T extends object>(
        service: ServiceClass<T>,
        instanceOrFactory: T | ScopedServiceFactory<T, Context>,
      ): void {
        this.services.provide(service, instanceOrFactory);
      }

      resolve<T extends object>(identifier: ServiceIdentifier<T>): T {
        return this.services.resolve(identifier, this.serviceScope);
      }

      tryResolve<T extends object>(identifier: ServiceIdentifier<T>): T | undefined {
        return this.services.tryResolve(identifier, this.serviceScope);
      }

      isProvided<T extends object>(identifier: ServiceIdentifier<T>): boolean {
        return this.services.isProvided(identifier);
      }

      fork(name: string, options?: ForkOptions): Context {
        const existing = this.children.get(name);
        if (existing) {
          if (options !== undefined) {
            throw new Error(
              `Sub context "${name}" already exists, so the provided options cannot be applied. ` +
                `Call fork('${name}') without options to get the existing subcontext.`,
            );
          }
          return existing as unknown as Context;
        }
        const child = new RuntimeContext(name, undefined, options, this);
        this.children.set(name, child);
        return child as unknown as Context;
      }

      async start(): Promise<void> {
        await this.lifecycle.start();
      }

      async stop(): Promise<void> {
        await this.lifecycle.stop();
      }
    }

    return RuntimeContext as unknown as ContextClass<RootOptions, ForkOptions, Builtins>;
  }
}

export function defineContext<RootOptions, ForkOptions = undefined>(): ContextBuilder<RootOptions, ForkOptions> {
  return new ContextBuilder();
}
