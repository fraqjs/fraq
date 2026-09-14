import type { Config } from '../config';
import { normalizePluginName } from '../dependency';
import { getAppPath } from '../paths';
import { getNpmPluginVersions, getWorkspacePluginDependency } from '../workspace-plugins';

import path from 'node:path';

interface PackageJson {
  name: string;
  private: true;
  type: 'module';
  dependencies: Record<string, string>;
}

export function generateAppPackageJson(config: Config, appPath?: string): PackageJson {
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
      const local = /^(file:|link:)(.+)$/.exec(version);
      packageJson.dependencies[dependency] =
        appPath && local?.[2]
          ? `${local[1]}${path.resolve(getAppPath(), local[2]).split(path.sep).join('/')}`
          : version;
    }
  }
  for (const pluginName of Object.keys(config.workspacePlugins ?? {})) {
    const dependency = getWorkspacePluginDependency(config, pluginName, appPath);
    if (dependency !== undefined) {
      packageJson.dependencies[normalizePluginName(pluginName)] = dependency;
    }
  }
  return packageJson;
}
