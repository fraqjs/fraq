import type { Config } from '../config';
import { normalizePluginName } from '../dependency';
import { getNpmPluginVersions, getWorkspacePluginDependency } from '../workspace-plugins';

interface PackageJson {
  name: string;
  private: true;
  type: 'module';
  dependencies: Record<string, string>;
}

export function generateAppPackageJson(config: Config): PackageJson {
  const packageJson: PackageJson = {
    name: 'fraq-app',
    private: true,
    type: 'module',
    dependencies: {},
  };
  packageJson.dependencies['@fraqjs/fraq'] = config.fraqVersion;
  packageJson.dependencies['@fraqjs/color-log'] = config.fraqVersion;
  for (const [pluginName, version] of Object.entries(getNpmPluginVersions(config))) {
    packageJson.dependencies[normalizePluginName(pluginName)] = version;
  }
  if (config.additionalDependencies) {
    for (const [dependency, version] of Object.entries(config.additionalDependencies)) {
      packageJson.dependencies[dependency] = version;
    }
  }
  for (const pluginName of Object.keys(config.workspacePlugins ?? {})) {
    const dependency = getWorkspacePluginDependency(config, pluginName);
    if (dependency !== undefined) {
      packageJson.dependencies[normalizePluginName(pluginName)] = dependency;
    }
  }
  return packageJson;
}
