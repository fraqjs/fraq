import {
  implementsESNextDisposable,
  isDisposable,
  type ScopedServiceFactory,
  type ServiceClass,
  type ServiceIdentifier,
  type ServiceScope,
  type ServiceToken,
} from '../service';

type ServiceProvider<C extends object> =
  | {
      type: 'instance';
      service: ServiceClass;
      instance: object;
    }
  | {
      type: 'factory';
      service: ServiceClass;
      create: ScopedServiceFactory<object, C>;
    };

export interface ServiceResolutionScope<C extends object> {
  readonly key: object;
  readonly value: ServiceScope<C>;
}

function getServiceToken<T extends object>(identifier: ServiceIdentifier<T>): ServiceToken<T> {
  return typeof identifier === 'function' ? identifier.token : identifier;
}

function checkServiceInstance(service: ServiceClass, instance: unknown): asserts instance is object {
  if ((typeof instance !== 'object' && typeof instance !== 'function') || instance === null) {
    throw new TypeError(`Service ${service.name} provider did not return an object.`);
  }
  if (implementsESNextDisposable(instance) && !isDisposable(instance)) {
    throw new Error(`Service ${service.name} implements Symbol.dispose but does not provide dispose().`);
  }
}

export class ServiceRegistry<C extends object> {
  private readonly providers = new Map<string, ServiceProvider<C>>();
  private readonly scopedInstances = new Map<object, Map<ServiceProvider<C>, object>>();
  private readonly resolvingScopedProviders = new Map<object, Set<ServiceProvider<C>>>();
  private readonly instances: object[] = [];

  constructor(private readonly parent?: ServiceRegistry<C>) {}

  provide<T extends object>(service: ServiceClass<T>, instanceOrFactory: T | ScopedServiceFactory<T, C>): void {
    if (this.providers.has(service.token.key)) {
      throw new Error(`Service ${service.token.key} has already been provided in this context.`);
    }

    if (typeof instanceOrFactory === 'function') {
      this.providers.set(service.token.key, {
        type: 'factory',
        service,
        create: instanceOrFactory,
      });
      return;
    }

    checkServiceInstance(service, instanceOrFactory);
    this.providers.set(service.token.key, { type: 'instance', service, instance: instanceOrFactory });
    this.instances.push(instanceOrFactory);
  }

  resolve<T extends object>(identifier: ServiceIdentifier<T>, scope: ServiceResolutionScope<C>): T {
    const token = getServiceToken(identifier);
    const instance = this.tryResolve(token, scope);
    if (instance === undefined) {
      throw new Error(`Service ${token.key} has not been provided.`);
    }
    return instance;
  }

  tryResolve<T extends object>(identifier: ServiceIdentifier<T>, scope: ServiceResolutionScope<C>): T | undefined {
    const token = getServiceToken(identifier);
    const provider = this.findProvider(token);
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
      throw new Error(`Circular scoped service resolution involving ${token.key}.`);
    }
    resolvingProviders ??= new Set();
    resolvingProviders.add(provider);
    this.resolvingScopedProviders.set(scope.key, resolvingProviders);

    let instance: object;
    try {
      instance = provider.create(scope.value);
      checkServiceInstance(provider.service, instance);
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

  isProvided<T extends object>(identifier: ServiceIdentifier<T>): boolean {
    return this.findProvider(getServiceToken(identifier)) !== undefined;
  }

  ownServiceTokens(): ServiceToken[] {
    return [...this.providers.values()].map(({ service }) => service.token);
  }

  hasOwn(token: ServiceToken): boolean {
    return this.providers.has(token.key);
  }

  collectAvailableServiceTokens(): ServiceToken[] {
    const services = this.ownServiceTokens();
    if (this.parent) {
      services.push(...this.parent.collectAvailableServiceTokens());
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

  private findProvider(token: ServiceToken): ServiceProvider<C> | undefined {
    return this.providers.get(token.key) ?? this.parent?.findProvider(token);
  }
}
