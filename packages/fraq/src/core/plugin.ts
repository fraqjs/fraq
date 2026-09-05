import type {
  Injection,
  Plugin as KernelPlugin,
  PluginDefinition as KernelPluginDefinition,
  OptionalInjection,
  ParameterList,
} from '@fraqjs/kernel';

import type { Context } from './context';

export type { Injection, OptionalInjection, ParameterList } from '@fraqjs/kernel';

export type Plugin<
  T extends ParameterList,
  I extends Injection | undefined,
  OI extends OptionalInjection | undefined = undefined,
> = KernelPlugin<Context, T, I, OI>;

export type PluginDefinition<T extends ParameterList> = KernelPluginDefinition<Context, T>;

export function definePlugin<
  T extends ParameterList,
  I extends Injection | undefined,
  OI extends OptionalInjection | undefined,
>(plugin: Plugin<T, I, OI>): PluginDefinition<T> {
  return plugin;
}
