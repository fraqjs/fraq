/** biome-ignore-all lint/suspicious/noExplicitAny: Service constructors may accept any arguments. */

export type ServiceClass<T extends object = object> = (abstract new (
  ...args: any[]
) => T) & {
  token: ServiceToken<T>;
};

declare const serviceTokenType: unique symbol;

export interface ServiceToken<T extends object = object> {
  readonly key: string;
  readonly [serviceTokenType]?: T;
}

export type ServiceIdentifier<T extends object = object> = ServiceClass<T> | ServiceToken<T>;

export interface ServiceScope<C extends object = object> {
  readonly context: C;
  readonly contextPath: readonly string[];
  readonly plugin?: string;
}

export type ScopedServiceFactory<T extends object, C extends object = object> = (scope: ServiceScope<C>) => T;

export interface Disposable {
  dispose(): void | Promise<void>;
}

export function serviceToken<T extends object>(key: string): ServiceToken<T> {
  return Object.freeze({ key });
}

export function isDisposable(service: object): service is Disposable {
  return 'dispose' in service && typeof service.dispose === 'function';
}

export function implementsESNextDisposable(service: object): boolean {
  return Symbol.dispose in service && typeof (service as any)[Symbol.dispose] === 'function';
}
