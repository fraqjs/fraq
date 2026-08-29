/** biome-ignore-all lint/suspicious/noExplicitAny: Plugin arguments and context capabilities are user-defined. */
/** biome-ignore-all lint/complexity/noBannedTypes: Empty object types model absent injections. */
import type { KernelContext } from './context';
import type { ServiceClass, ServiceToken } from './service';

export type ParameterList = Array<any>;
export type Injection = Record<string, ServiceClass>;
export type OptionalInjection = Record<string, ServiceToken>;

export type InjectedServices<I extends Injection | undefined> = I extends Injection
  ? { [K in keyof I]: InstanceType<I[K]> }
  : {};

export type OptionalInjectedServices<I extends OptionalInjection | undefined> = I extends OptionalInjection
  ? { [K in keyof I]: I[K] extends ServiceToken<infer T> ? T | undefined : never }
  : {};

export interface Plugin<
  C extends object,
  T extends ParameterList,
  I extends Injection | undefined,
  OI extends OptionalInjection | undefined = undefined,
> {
  name: string;
  inject?: I;
  optionalInject?: OI;
  provides?: readonly ServiceClass[];
  apply(ctx: C & InjectedServices<I> & OptionalInjectedServices<OI>, ...args: T): void | Promise<void>;
  start?(ctx: C & InjectedServices<I> & OptionalInjectedServices<OI>): void | Promise<void>;
}

export type PluginDefinition<C extends object, T extends ParameterList> = Plugin<
  C,
  T,
  Injection | undefined,
  OptionalInjection | undefined
>;

export function createPluginFactory<C extends object>() {
  return function definePlugin<
    T extends ParameterList,
    I extends Injection | undefined,
    OI extends OptionalInjection | undefined,
  >(plugin: Plugin<C, T, I, OI>): PluginDefinition<C, T> {
    return plugin;
  };
}

export type CommonContext = Pick<
  KernelContext<any, never>,
  'name' | 'logger' | 'logBus' | 'timeout' | 'interval' | 'provide' | 'resolve' | 'tryResolve' | 'isProvided'
>;

export const defineCommonPlugin = createPluginFactory<CommonContext>();
