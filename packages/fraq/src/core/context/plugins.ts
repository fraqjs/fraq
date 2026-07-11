import { Logger, type LogHandler } from '../logging';
import type { Injection, ParameterList, Plugin } from '../plugin';
import { implementsESNextDisposable, isDisposable, type ServiceClass } from '../service';
import type { Context } from './index';

type AnyPlugin = Plugin<ParameterList, Injection | undefined, Injection | undefined>;

export type InstalledPlugin = {
  plugin: AnyPlugin;
  args: ParameterList;
  proxy?: Context;
};

function areRequiredServicesAvailable(plugin: AnyPlugin, available: Set<ServiceClass>): boolean {
  return (plugin.requires ?? []).every((service) => available.has(service));
}

function areOptionalServicesReady(
  plugin: AnyPlugin,
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

function createUnresolvablePluginError(pending: InstalledPlugin[], available: Set<ServiceClass>): Error {
  const missingRequirements = new Map<ServiceClass, AnyPlugin[]>();
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
    const reason = pendingProviders.has(service) ? 'blocked by a dependency cycle' : 'no installed plugin provides it';
    return `${service.name} required by ${dependents} (${reason})`;
  });

  return new Error(`Unable to resolve plugin service dependencies: ${lines.join('; ')}.`);
}

export class PluginRegistry {
  private readonly plugins: InstalledPlugin[] = [];
  private readonly services = new Map<ServiceClass, object>();

  constructor(
    private readonly context: Context,
    private readonly parent: PluginRegistry | undefined,
    private readonly logHandler: LogHandler | undefined,
  ) {}

  install<T extends ParameterList, I extends Injection | undefined, OI extends Injection | undefined>(
    plugin: Plugin<T, I, OI>,
    ...args: T
  ): void {
    this.plugins.push({ plugin: plugin as AnyPlugin, args });
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

  async apply(): Promise<InstalledPlugin[]> {
    const sortedPlugins = this.sortPlugins();
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
      this.context.logger.info(applyingMessage);
      await plugin.apply(this.getPluginContext(installedPlugin), ...args);
      for (const service of plugin.provides ?? []) {
        if (!this.services.has(service) || providedBeforeApply.has(service)) {
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

  async disposeServices(): Promise<unknown[]> {
    const errors: unknown[] = [];
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
    return errors;
  }

  private sortPlugins(): InstalledPlugin[] {
    const providers = new Map<ServiceClass, AnyPlugin>();
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
    const available = new Set(this.collectAvailableServices());

    while (pending.length > 0) {
      const availableByPendingPlugins = new Map<ServiceClass, InstalledPlugin>();
      for (const installedPlugin of pending) {
        for (const service of installedPlugin.plugin.provides ?? []) {
          availableByPendingPlugins.set(service, installedPlugin);
        }
      }
      const requiredReadyIndex = pending.findIndex(({ plugin }) => areRequiredServicesAvailable(plugin, available));
      const optionalReadyIndex = pending.findIndex(
        ({ plugin }) =>
          areRequiredServicesAvailable(plugin, available) &&
          areOptionalServicesReady(plugin, available, availableByPendingPlugins),
      );
      const nextIndex = optionalReadyIndex === -1 ? requiredReadyIndex : optionalReadyIndex;
      if (nextIndex === -1) {
        throw createUnresolvablePluginError(pending, available);
      }

      const [next] = pending.splice(nextIndex, 1);
      sorted.push(next);
      for (const service of next.plugin.provides ?? []) {
        available.add(service);
      }
    }

    return sorted;
  }

  private collectAvailableServices(): ServiceClass[] {
    const services = [...this.services.keys()];
    if (this.parent) {
      services.push(...this.parent.collectAvailableServices());
    }
    return services;
  }

  private getPluginContext(installedPlugin: InstalledPlugin): Context {
    installedPlugin.proxy ??= this.createProxyContextForPlugin(installedPlugin.plugin);
    return installedPlugin.proxy;
  }

  private createProxyContextForPlugin(plugin: AnyPlugin): Context {
    const proxyLogger = new Logger(
      (message) => this.logHandler?.(message),
      `plugin:${this.context.name ? `${this.context.name}/` : ''}${plugin.name}`,
    );
    const proxyRouter = this.context.router.withMeta({
      context: this.context.name,
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

    return new Proxy(this.context, {
      get(target, prop, receiver) {
        if (prop === 'logger') {
          return proxyLogger;
        }
        if (prop === 'router') {
          return proxyRouter;
        }
        if (proxyInjections && prop in proxyInjections) {
          return proxyInjections[prop as keyof typeof proxyInjections];
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}
