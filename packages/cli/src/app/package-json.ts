import type { Config } from '../config';
import { normalizePluginName } from '../dependency';

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
  for (const [pluginName, version] of Object.entries(config.versions)) {
    packageJson.dependencies[normalizePluginName(pluginName)] = version;
  }
  if (config.additionalDependencies) {
    for (const [dependency, version] of Object.entries(config.additionalDependencies)) {
      packageJson.dependencies[dependency] = version;
    }
  }
  packageJson.dependencies['@fraqjs/color-log'] = '0.2.0';
  return packageJson;
}
