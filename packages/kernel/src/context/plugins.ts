import type { Injection, OptionalInjection, ParameterList, PluginDefinition } from '../plugin';
import type { ServiceClass, ServiceIdentifier } from '../service';
import type { ServiceRegistry, ServiceResolutionScope } from './services';

type AnyPlugin<C extends object> = PluginDefinition<C, ParameterList>;

export type InstalledPlugin<C extends object> = {
  plugin: AnyPlugin<C>;
  args: ParameterList;
  proxy?: C;
  scope?: ServiceResolutionScope<C>;
};

export interface PluginRegistryOptions<C extends object> {
  createContextProperties?(context: C, plugin: AnyPlugin<C>): object | undefined;
  applying?(context: C, plugin: AnyPlugin<C>): void;
  starting?(context: C, plugin: AnyPlugin<C>): void;
}

function areInjectedServicesAvailable(plugin: { inject?: Injection }, available: Set<string>): boolean {
  return Object.values(plugin.inject ?? {}).every((service) => available.has(service.token.key));
}

function areOptionalInjectedServicesReady<C extends object>(
  plugin: { optionalInject?: OptionalInjection },
  available: Set<string>,
  pendingProviders: Map<string, InstalledPlugin<C>>,
): boolean {
  return Object.values(plugin.optionalInject ?? {}).every((token) => {
    if (available.has(token.key)) {
      return true;
    }
    const pendingProvider = pendingProviders.get(token.key);
    return pendingProvider === undefined || pendingProvider.plugin === plugin;
  });
}

function createUnresolvablePluginError<C extends object>(pending: InstalledPlugin<C>[], available: Set<string>): Error {
  const missingRequirements = new Map<string, { service: ServiceClass; plugins: AnyPlugin<C>[] }>();
  const pendingProviders = new Set<string>();
  for (const { plugin } of pending) {
    for (const service of plugin.provides ?? []) {
      pendingProviders.add(service.token.key);
    }
  }

  for (const { plugin } of pending) {
    for (const service of Object.values(plugin.inject ?? {})) {
      if (!available.has(service.token.key)) {
        const requirement = missingRequirements.get(service.token.key) ?? { service, plugins: [] };
        requirement.plugins.push(plugin);
        missingRequirements.set(service.token.key, requirement);
      }
    }
  }

  const lines = [...missingRequirements.values()].map(({ service, plugins }) => {
    const dependents = plugins.map((plugin) => plugin.name).join(', ');
    const reason = pendingProviders.has(service.token.key)
      ? 'blocked by a dependency cycle'
      : 'no installed plugin provides it';
    return `${service.name} required by ${dependents} (${reason})`;
  });

  return new Error(`Unable to resolve plugin service dependencies: ${lines.join('; ')}.`);
}

export class PluginRegistry<C extends object> {
  private readonly plugins: InstalledPlugin<C>[] = [];

  constructor(
    private readonly context: C,
    private readonly services: ServiceRegistry<C>,
    private readonly contextPath: readonly string[],
    private readonly options: PluginRegistryOptions<C>,
  ) {}

  install<T extends ParameterList>(plugin: PluginDefinition<C, T>, ...args: T): void {
    this.plugins.push({ plugin: plugin as AnyPlugin<C>, args });
  }

  async apply(): Promise<InstalledPlugin<C>[]> {
    const sortedPlugins = this.sortPlugins();
    for (const installedPlugin of sortedPlugins) {
      const { plugin, args } = installedPlugin;
      const providedBeforeApply = new Set(this.services.ownServiceTokens().map(({ key }) => key));
      this.options.applying?.(this.context, plugin);
      await plugin.apply(this.getPluginContext(installedPlugin), ...args);
      for (const service of plugin.provides ?? []) {
        if (!this.services.hasOwn(service.token) || providedBeforeApply.has(service.token.key)) {
          throw new Error(`${plugin.name} declares service ${service.name} but did not provide it.`);
        }
      }
    }
    return sortedPlugins;
  }

  async start(sortedPlugins: InstalledPlugin<C>[]): Promise<void> {
    for (const installedPlugin of sortedPlugins) {
      const { plugin } = installedPlugin;
      if (!plugin.start) {
        continue;
      }
      this.options.starting?.(this.context, plugin);
      await plugin.start(this.getPluginContext(installedPlugin));
    }
  }

  private resolve<T extends object>(identifier: ServiceIdentifier<T>, installedPlugin: InstalledPlugin<C>): T {
    return this.services.resolve(identifier, this.getPluginScope(installedPlugin));
  }

  private tryResolve<T extends object>(
    identifier: ServiceIdentifier<T>,
    installedPlugin: InstalledPlugin<C>,
  ): T | undefined {
    return this.services.tryResolve(identifier, this.getPluginScope(installedPlugin));
  }

  private sortPlugins(): InstalledPlugin<C>[] {
    const providers = new Map<string, AnyPlugin<C>>();
    for (const { plugin } of this.plugins) {
      for (const service of plugin.provides ?? []) {
        const existingProvider = providers.get(service.token.key);
        if (existingProvider) {
          throw new Error(
            `Service ${service.name} is declared by multiple plugins: ${existingProvider.name} and ${plugin.name}.`,
          );
        }
        providers.set(service.token.key, plugin);
      }
    }

    const pending = [...this.plugins];
    const sorted: InstalledPlugin<C>[] = [];
    const available = new Set(this.services.collectAvailableServiceTokens().map(({ key }) => key));
    while (pending.length > 0) {
      const pendingProviders = new Map<string, InstalledPlugin<C>>();
      for (const installedPlugin of pending) {
        for (const service of installedPlugin.plugin.provides ?? []) {
          pendingProviders.set(service.token.key, installedPlugin);
        }
      }
      const requiredReadyIndex = pending.findIndex(({ plugin }) => areInjectedServicesAvailable(plugin, available));
      const optionalReadyIndex = pending.findIndex(
        ({ plugin }) =>
          areInjectedServicesAvailable(plugin, available) &&
          areOptionalInjectedServicesReady(plugin, available, pendingProviders),
      );
      const nextIndex = optionalReadyIndex === -1 ? requiredReadyIndex : optionalReadyIndex;
      if (nextIndex === -1) {
        throw createUnresolvablePluginError(pending, available);
      }

      const [next] = pending.splice(nextIndex, 1);
      sorted.push(next);
      for (const service of next.plugin.provides ?? []) {
        available.add(service.token.key);
      }
    }
    return sorted;
  }

  private getPluginContext(installedPlugin: InstalledPlugin<C>): C {
    installedPlugin.proxy ??= this.createProxyContextForPlugin(installedPlugin);
    return installedPlugin.proxy;
  }

  private getPluginScope(installedPlugin: InstalledPlugin<C>): ServiceResolutionScope<C> {
    installedPlugin.scope ??= {
      key: installedPlugin,
      value: {
        context: this.getPluginContext(installedPlugin),
        contextPath: this.contextPath,
        plugin: installedPlugin.plugin.name,
      },
    };
    return installedPlugin.scope;
  }

  private createProxyContextForPlugin(installedPlugin: InstalledPlugin<C>): C {
    const { plugin } = installedPlugin;
    const contextProperties = this.options.createContextProperties?.(this.context, plugin);
    const injections = new Map<string, object | undefined>();
    const resolve = <T extends object>(identifier: ServiceIdentifier<T>) => this.resolve(identifier, installedPlugin);
    const tryResolve = <T extends object>(identifier: ServiceIdentifier<T>) =>
      this.tryResolve(identifier, installedPlugin);
    const isProvided = (identifier: ServiceIdentifier) => this.services.isProvided(identifier);

    const proxy = new Proxy(this.context, {
      get(target, prop, receiver) {
        if (prop === 'resolve') {
          return resolve;
        }
        if (prop === 'tryResolve') {
          return tryResolve;
        }
        if (prop === 'isProvided') {
          return isProvided;
        }
        if (contextProperties && Object.hasOwn(contextProperties, prop)) {
          return Reflect.get(contextProperties, prop, contextProperties);
        }
        if (typeof prop === 'string' && injections.has(prop)) {
          return injections.get(prop);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    installedPlugin.proxy = proxy;

    for (const [key, service] of Object.entries(plugin.inject ?? {})) {
      injections.set(key, resolve(service));
    }
    for (const [key, token] of Object.entries(plugin.optionalInject ?? {})) {
      injections.set(key, tryResolve(token));
    }
    return proxy;
  }
}
