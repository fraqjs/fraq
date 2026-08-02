import { Logger, type LogHandler } from '../logging';
import type { ParameterList, PluginDefinition } from '../plugin';
import type { ServiceClass, ServiceIdentifier } from '../service';
import type { Context } from './index';
import type { ServiceRegistry, ServiceResolutionScope } from './services';

type AnyPlugin = PluginDefinition<ParameterList>;

export type InstalledPlugin = {
  plugin: AnyPlugin;
  args: ParameterList;
  proxy?: Context;
  scope?: ServiceResolutionScope;
};

function areInjectedServicesAvailable(plugin: AnyPlugin, available: Set<string>): boolean {
  return Object.values(plugin.inject ?? {}).every((service) => available.has(service.token.key));
}

function areOptionalInjectedServicesReady(
  plugin: AnyPlugin,
  available: Set<string>,
  pendingProviders: Map<string, InstalledPlugin>,
): boolean {
  return Object.values(plugin.optionalInject ?? {}).every((token) => {
    if (available.has(token.key)) {
      return true;
    }
    const pendingProvider = pendingProviders.get(token.key);
    return pendingProvider === undefined || pendingProvider.plugin === plugin;
  });
}

function createUnresolvablePluginError(pending: InstalledPlugin[], available: Set<string>): Error {
  const missingRequirements = new Map<string, { service: ServiceClass; plugins: AnyPlugin[] }>();
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

export class PluginRegistry {
  private readonly plugins: InstalledPlugin[] = [];

  constructor(
    private readonly context: Context,
    private readonly services: ServiceRegistry,
    private readonly contextPath: readonly string[],
    private readonly logHandler: LogHandler | undefined,
  ) {}

  install<T extends ParameterList>(plugin: PluginDefinition<T>, ...args: T): void {
    this.plugins.push({ plugin: plugin as AnyPlugin, args });
  }

  private resolve<T extends object>(identifier: ServiceIdentifier<T>, installedPlugin: InstalledPlugin): T {
    return this.services.resolve(identifier, this.getPluginScope(installedPlugin));
  }

  private tryResolve<T extends object>(
    identifier: ServiceIdentifier<T>,
    installedPlugin: InstalledPlugin,
  ): T | undefined {
    return this.services.tryResolve(identifier, this.getPluginScope(installedPlugin));
  }

  private isProvided<T extends object>(identifier: ServiceIdentifier<T>): boolean {
    return this.services.isProvided(identifier);
  }

  async apply(): Promise<InstalledPlugin[]> {
    const sortedPlugins = this.sortPlugins();
    for (const installedPlugin of sortedPlugins) {
      const { plugin, args } = installedPlugin;
      const providedBeforeApply = new Set(this.services.ownServiceTokens().map(({ key }) => key));
      let applyingMessage = `Applying plugin ${plugin.name}`;
      const injectedServices: string[] = [];
      const providedServices: string[] = [];
      for (const service of Object.values(plugin.inject ?? {})) {
        injectedServices.push(service.name);
      }
      for (const token of Object.values(plugin.optionalInject ?? {})) {
        injectedServices.push(`${token.key}?`);
      }
      if (plugin.provides) {
        for (const service of plugin.provides) {
          providedServices.push(service.name);
        }
      }
      if (injectedServices.length > 0) {
        applyingMessage += `, injects: [${injectedServices.join(', ')}]`;
      }
      if (providedServices.length > 0) {
        applyingMessage += `, provides: [${providedServices.join(', ')}]`;
      }
      this.context.logger.info(applyingMessage);
      await plugin.apply(this.getPluginContext(installedPlugin), ...args);
      for (const service of plugin.provides ?? []) {
        if (!this.services.hasOwn(service.token) || providedBeforeApply.has(service.token.key)) {
          throw new Error(`${plugin.name} declares service ${service.name} but did not provide it.`);
        }
      }
    }
    return sortedPlugins;
  }

  async start(sortedPlugins: InstalledPlugin[]): Promise<void> {
    for (const installedPlugin of sortedPlugins) {
      const { plugin } = installedPlugin;
      if (!plugin.start) {
        continue;
      }
      this.context.logger.debug(`Plugin ${plugin.name} is starting...`);
      await plugin.start(this.getPluginContext(installedPlugin));
    }
  }

  private sortPlugins(): InstalledPlugin[] {
    const providers = new Map<string, AnyPlugin>();
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
    const sorted: InstalledPlugin[] = [];
    const available = new Set(this.services.collectAvailableServiceTokens().map(({ key }) => key));

    while (pending.length > 0) {
      const availableByPendingPlugins = new Map<string, InstalledPlugin>();
      for (const installedPlugin of pending) {
        for (const service of installedPlugin.plugin.provides ?? []) {
          availableByPendingPlugins.set(service.token.key, installedPlugin);
        }
      }
      const requiredReadyIndex = pending.findIndex(({ plugin }) => areInjectedServicesAvailable(plugin, available));
      const optionalReadyIndex = pending.findIndex(
        ({ plugin }) =>
          areInjectedServicesAvailable(plugin, available) &&
          areOptionalInjectedServicesReady(plugin, available, availableByPendingPlugins),
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

  private getPluginContext(installedPlugin: InstalledPlugin): Context {
    installedPlugin.proxy ??= this.createProxyContextForPlugin(installedPlugin);
    return installedPlugin.proxy;
  }

  private getPluginScope(installedPlugin: InstalledPlugin): ServiceResolutionScope {
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

  private createProxyContextForPlugin(installedPlugin: InstalledPlugin): Context {
    const { plugin } = installedPlugin;
    const proxyLogger = new Logger(
      (message) => this.logHandler?.(message),
      `plugin:${this.context.name ? `${this.context.name}/` : ''}${plugin.name}`,
    );
    const proxyRouter = this.context.router.withMeta({
      context: this.context.name,
      plugin: plugin.name,
    });

    const proxyInjections = new Map<string, object | undefined>();
    const resolve = <T extends object>(identifier: ServiceIdentifier<T>) => this.resolve(identifier, installedPlugin);
    const tryResolve = <T extends object>(identifier: ServiceIdentifier<T>) =>
      this.tryResolve(identifier, installedPlugin);
    const isProvided = (identifier: ServiceIdentifier) => this.isProvided(identifier);

    const proxy = new Proxy(this.context, {
      get(target, prop, receiver) {
        if (prop === 'logger') {
          return proxyLogger;
        }
        if (prop === 'router') {
          return proxyRouter;
        }
        if (prop === 'resolve') {
          return resolve;
        }
        if (prop === 'tryResolve') {
          return tryResolve;
        }
        if (prop === 'isProvided') {
          return isProvided;
        }
        if (typeof prop === 'string') {
          if (proxyInjections.has(prop)) {
            return proxyInjections.get(prop);
          }
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    installedPlugin.proxy = proxy;

    for (const [key, service] of Object.entries(plugin.inject ?? {})) {
      proxyInjections.set(key, resolve(service));
    }
    for (const [key, token] of Object.entries(plugin.optionalInject ?? {})) {
      proxyInjections.set(key, tryResolve(token));
    }

    return proxy;
  }
}
