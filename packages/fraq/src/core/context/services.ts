import {
  implementsESNextDisposable,
  isDisposable,
  type ScopedServiceFactory,
  type ServiceClass,
  type ServiceScope,
} from '../service';

type ServiceProvider =
  | {
      type: 'instance';
      instance: object;
    }
  | {
      type: 'factory';
      create: ScopedServiceFactory<object>;
    };

export interface ServiceResolutionScope {
  readonly key: object;
  readonly value: ServiceScope;
}

function checkServiceInstance(service: ServiceClass, instance: unknown): asserts instance is object {
  if ((typeof instance !== 'object' && typeof instance !== 'function') || instance === null) {
    throw new TypeError(`Service ${service.name} provider did not return an object.`);
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
}

export class ServiceRegistry {
  private readonly providers = new Map<ServiceClass, ServiceProvider>();
  private readonly scopedInstances = new Map<object, Map<ServiceProvider, object>>();
  private readonly resolvingScopedProviders = new Map<object, Set<ServiceProvider>>();
  private readonly instances: object[] = [];

  constructor(private readonly parent?: ServiceRegistry) {}

  provide<T extends object>(service: ServiceClass<T>, instanceOrFactory: T | ScopedServiceFactory<T>): void {
    if (this.providers.has(service)) {
      throw new Error(`Service ${service.name} has already been provided in this context.`);
    }

    if (typeof instanceOrFactory === 'function') {
      this.providers.set(service, {
        type: 'factory',
        create: instanceOrFactory,
      });
      return;
    }

    checkServiceInstance(service, instanceOrFactory);
    this.providers.set(service, { type: 'instance', instance: instanceOrFactory });
    this.instances.push(instanceOrFactory);
  }

  resolve<T extends object>(service: ServiceClass<T>, scope: ServiceResolutionScope): T {
    const instance = this.tryResolve(service, scope);
    if (instance === undefined) {
      throw new Error(`Service ${service.name} has not been provided.`);
    }
    return instance;
  }

  tryResolve<T extends object>(service: ServiceClass<T>, scope: ServiceResolutionScope): T | undefined {
    const provider = this.providers.get(service) ?? this.parent?.findProvider(service);
    if (!provider) {
      return undefined;
    }
    if (provider.type === 'instance') {
      return provider.instance as T;
    }

    let instances = this.scopedInstances.get(scope.key);
    if (instances?.has(provider)) {
      return instances.get(provider) as T;
    }

    let resolvingProviders = this.resolvingScopedProviders.get(scope.key);
    if (resolvingProviders?.has(provider)) {
      throw new Error(`Circular scoped service resolution involving ${service.name}.`);
    }
    resolvingProviders ??= new Set();
    resolvingProviders.add(provider);
    this.resolvingScopedProviders.set(scope.key, resolvingProviders);

    let instance: object;
    try {
      instance = provider.create(scope.value);
      checkServiceInstance(service, instance);
    } finally {
      resolvingProviders.delete(provider);
      if (resolvingProviders.size === 0) {
        this.resolvingScopedProviders.delete(scope.key);
      }
    }

    instances ??= new Map();
    instances.set(provider, instance);
    this.scopedInstances.set(scope.key, instances);
    this.instances.push(instance);
    return instance as T;
  }

  isProvided<T extends object>(service: ServiceClass<T>): boolean {
    return this.findProvider(service) !== undefined;
  }

  ownServiceClasses(): ServiceClass[] {
    return [...this.providers.keys()];
  }

  hasOwn(service: ServiceClass): boolean {
    return this.providers.has(service);
  }

  collectAvailableServiceClasses(): ServiceClass[] {
    const services = this.ownServiceClasses();
    if (this.parent) {
      services.push(...this.parent.collectAvailableServiceClasses());
    }
    return services;
  }

  async dispose(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const instance of this.instances.toReversed()) {
      if (!isDisposable(instance)) {
        continue;
      }
      try {
        await instance.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private findProvider(service: ServiceClass): ServiceProvider | undefined {
    return this.providers.get(service) ?? this.parent?.findProvider(service);
  }
}
