import type { Config, ContextConfig } from './config';
import type { FileAccessHandler } from './config/references';
import { getPackageJson } from './package-jsons';
import { getWorkspacePluginPackageJson, isWorkspacePlugin } from './workspace-plugins';

export type PluginDependencyDiagnostic = { status: 'ok' } | { status: 'missing'; message: string[] };

// Schema:
// pluginName -> fraq-plugin-${pluginName}
// scope/pluginName -> @scope/fraq-plugin-${pluginName}
// fraqjs/pluginName -> @fraqjs/plugin-${pluginName}
//
// Example:
// foo -> fraq-plugin-foo
// bar/foo -> @bar/fraq-plugin-foo
// fraqjs/foo -> @fraqjs/fraq-plugin-foo
export function normalizePluginName(pluginName: string): string {
  const parts = pluginName.split('/');
  if (parts.length === 1) {
    return `fraq-plugin-${pluginName}`;
  } else if (parts.length === 2) {
    const [scope, name] = parts;
    if (scope === 'fraqjs') {
      return `@fraqjs/plugin-${name}`;
    } else {
      return `@${scope}/fraq-plugin-${name}`;
    }
  } else {
    throw new Error(`Invalid plugin name: ${pluginName}`);
  }
}

// Reverse of normalizePluginName. Converts a normalized plugin name back to its original form.
export function denormalizePluginName(normalizedPluginName: string): string {
  if (normalizedPluginName.startsWith('@')) {
    const parts = normalizedPluginName.split('/');
    if (parts.length !== 2) {
      throw new Error(`Invalid normalized plugin name: ${normalizedPluginName}`);
    }
    const [scope, name] = parts;
    if (scope === '@fraqjs') {
      if (!name.startsWith('plugin-')) {
        throw new Error(`Invalid normalized plugin name: ${normalizedPluginName}`);
      }
      return `fraqjs/${name.slice('plugin-'.length)}`;
    } else {
      if (!name.startsWith('fraq-plugin-')) {
        throw new Error(`Invalid normalized plugin name: ${normalizedPluginName}`);
      }
      return `${scope.slice(1)}/${name.slice('fraq-plugin-'.length)}`;
    }
  } else {
    if (!normalizedPluginName.startsWith('fraq-plugin-')) {
      throw new Error(`Invalid normalized plugin name: ${normalizedPluginName}`);
    }
    return normalizedPluginName.slice('fraq-plugin-'.length);
  }
}

export async function getPluginDependencyDiagnostic(
  config: Config,
  options: { onFileAccess?: FileAccessHandler } = {},
): Promise<PluginDependencyDiagnostic> {
  const messages: string[] = [];

  async function inspectContext(
    context: ContextConfig,
    parentPlugins: ReadonlySet<string>,
    contextPath: readonly string[],
  ): Promise<void> {
    const plugins = Object.keys(context.plugins ?? {}).map((name) => ({
      name,
      packageName: normalizePluginName(name),
    }));
    const visiblePlugins = new Set(parentPlugins);
    for (const plugin of plugins) {
      visiblePlugins.add(plugin.packageName);
    }

    const contextName = contextPath.length === 0 ? 'root' : contextPath.join('/');
    for (const plugin of plugins) {
      let packageJson: Record<string, unknown>;
      if (isWorkspacePlugin(config, plugin.name)) {
        packageJson = getWorkspacePluginPackageJson(config, plugin.name, plugin.packageName, options.onFileAccess);
      } else {
        const version = config.versions[plugin.name];
        if (typeof version !== 'string' || version.trim().length === 0) {
          throw new Error(
            `Plugin "${plugin.name}" in context "${contextName}" has no version declared in config.versions.`,
          );
        }
        packageJson = await getPackageJson(plugin.packageName, version);
      }
      const peerDependencies = packageJson.peerDependencies;
      if (peerDependencies === null || typeof peerDependencies !== 'object' || Array.isArray(peerDependencies)) {
        continue;
      }
      const peerDependenciesMeta = packageJson.peerDependenciesMeta;

      for (const dependencyPackageName of Object.keys(peerDependencies)) {
        const dependencyMeta =
          peerDependenciesMeta !== null &&
          typeof peerDependenciesMeta === 'object' &&
          !Array.isArray(peerDependenciesMeta)
            ? (peerDependenciesMeta as Record<string, unknown>)[dependencyPackageName]
            : undefined;
        if (
          dependencyMeta !== null &&
          typeof dependencyMeta === 'object' &&
          !Array.isArray(dependencyMeta) &&
          'optional' in dependencyMeta &&
          dependencyMeta.optional === true
        ) {
          continue;
        }

        let dependencyName: string;
        try {
          dependencyName = denormalizePluginName(dependencyPackageName);
        } catch {
          continue;
        }

        if (!visiblePlugins.has(dependencyPackageName)) {
          messages.push(
            `Plugin "${plugin.name}" in context "${contextName}" requires plugin "${dependencyName}", but it is not installed in that context or any parent context.`,
          );
        }
      }
    }

    for (const [forkName, fork] of Object.entries(context.forks ?? {})) {
      await inspectContext(fork, visiblePlugins, [...contextPath, forkName]);
    }
  }

  await inspectContext(config, new Set(), []);

  return messages.length === 0 ? { status: 'ok' } : { status: 'missing', message: messages };
}
