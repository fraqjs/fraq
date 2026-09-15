import chalk from 'chalk';
import YAML from 'yaml';

import { loadConfig, loadProjectConfig } from '../config';
import type { FileAccessHandler } from '../config/references';
import { getPluginDependencyDiagnostic, normalizePluginName } from '../dependency';
import { selectPackageManager } from '../package-manager';
import { getVersionsPath } from '../paths';
import { completeAndSyncVersions, readVersions } from '../versions';
import { getWorkspacePluginEntryPoint } from '../workspace-plugins';
import type { PreparedApp } from './lifecycle';

import { writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export async function syncVersions(
  options: { onFileAccess?: FileAccessHandler; silent?: boolean } = {},
): Promise<boolean> {
  if (!options.silent) console.log(chalk.cyan('Syncing lockfile versions...'));
  const config = await loadConfig({ onFileAccess: options.onFileAccess, throwOnValidationError: true });
  const locked = readVersions();
  config.versions = { ...locked, ...config.versions };
  const completed = await completeAndSyncVersions(config, config.versions);
  const changed = !isDeepStrictEqual(locked, completed);
  if (changed) writeFileSync(getVersionsPath(), YAML.stringify(completed));
  if (!options.silent) console.log(chalk.green('Successfully synced lockfile versions.'));
  return changed;
}

export async function prepareApp(
  options: { watch?: boolean; frozenLockfile?: boolean } = {},
  accessedFiles = new Set<string>(),
): Promise<PreparedApp> {
  const onFileAccess = (file: string) => {
    accessedFiles.add(file);
  };
  accessedFiles.add(getVersionsPath());
  if (!options.frozenLockfile) await syncVersions({ onFileAccess, silent: options.watch });
  const config = await loadProjectConfig({ resolveAllReferences: true, onFileAccess });
  const diagnostic = await getPluginDependencyDiagnostic(config, { onFileAccess });
  if (diagnostic.status === 'missing') {
    throw new Error(`There are issues with the plugin dependencies:\n${diagnostic.message.join('\n')}`);
  }
  const restartFiles = new Set<string>();
  if (options.watch) {
    for (const name of Object.keys(config.workspacePlugins ?? {})) {
      const entry = getWorkspacePluginEntryPoint(config, name, normalizePluginName(name), onFileAccess);
      accessedFiles.add(entry);
      restartFiles.add(entry);
    }
  }
  return { config, packageManager: await selectPackageManager(config.packageManager), restartFiles };
}
