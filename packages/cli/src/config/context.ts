import type { ContextConfig } from './index';

export function collectPluginNames(context: ContextConfig): Set<string> {
  const pluginNames = new Set<string>();
  function walk(ctx: ContextConfig): void {
    for (const name of Object.keys(ctx.plugins ?? {})) {
      pluginNames.add(name);
    }
    for (const fork of Object.values(ctx.forks ?? {})) {
      walk(fork);
    }
  }
  walk(context);
  return pluginNames;
}
