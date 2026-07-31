/** biome-ignore-all lint/suspicious/noExplicitAny: Service constructors may accept any arguments. */
import type { Context } from './context';

export type ServiceClass<T extends object = object> = abstract new (...args: any[]) => T;

export interface ServiceScope {
  readonly context: Context;
  readonly contextPath: readonly string[];
  readonly plugin?: string;
}

export type ScopedServiceFactory<T extends object> = (scope: ServiceScope) => T;

export interface Disposable {
  dispose(): void | Promise<void>;
}

export function isDisposable(service: object): service is Disposable {
  return 'dispose' in service && typeof service.dispose === 'function';
}

export function implementsESNextDisposable(service: object): boolean {
  return Symbol.dispose in service && typeof (service as any)[Symbol.dispose] === 'function';
}
