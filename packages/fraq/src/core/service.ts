/** biome-ignore-all lint/suspicious/noExplicitAny: Service constructors may accept any arguments. */
import type { Context } from './context';

export type ServiceClass<T extends object = object> = (abstract new (
  ...args: any[]
) => T) & {
  token: ServiceToken<T>;
};

export interface ServiceToken<_T extends object = object> {
  key: string;
}

export interface ServiceScope {
  readonly context: Context;
  readonly contextPath: readonly string[];
  readonly plugin?: string;
}

export type ScopedServiceFactory<T extends object> = (scope: ServiceScope) => T;

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
