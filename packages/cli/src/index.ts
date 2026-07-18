#!/usr/bin/env node

import { startApp } from './app';
import { loadConfig } from './config';
import { getPluginDependencyDiagnostic } from './dependency';
import { detectPackageManager, type PackageManagerInfo } from './package-manager';

const config = await loadConfig();

let packageManager: PackageManagerInfo | undefined;
if (config.packageManager) {
  const result = detectPackageManager(config.packageManager);
  if (!result?.installed || !result?.commandPath) {
    throw new Error(`Specified package manager '${config.packageManager}' is not found in the system PATH.`);
  }
  packageManager = result;
} else {
  // Try along pnpm -> yarn -> npm
  for (const name of ['pnpm', 'yarn', 'npm'] as const) {
    const result = detectPackageManager(name);
    if (result?.installed && result?.commandPath) {
      packageManager = result;
      break;
    }
  }
}
if (!packageManager?.commandPath) {
  throw new Error(
    "No package manager found in the system PATH. Please install one of 'pnpm', 'yarn', or 'npm', or specify a package manager in the configuration.",
  );
}

const diagnostic = await getPluginDependencyDiagnostic(config);
if (diagnostic.status === 'missing') {
  console.error('There are issues with the plugin dependencies:');
  for (const issue of diagnostic.message) {
    console.error(`- ${issue}`);
  }
  console.error('Please resolve the above issues before proceeding.');
  process.exit(1);
}

process.exitCode = await startApp(config, {
  name: packageManager.name,
  commandPath: packageManager.commandPath,
});
