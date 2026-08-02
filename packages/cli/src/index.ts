#!/usr/bin/env node

import * as inq from '@inquirer/prompts';
import chalk from 'chalk';
import * as c from 'cmd-ts';
import YAML from 'yaml';
import type z from 'zod';

import pkg from '../package.json';
import { startApp, startInstall } from './app';
import { startWatchedApp } from './app/lifecycle';
import type { Config, DependencyConfig } from './config';
import { loadConfig } from './config';
import type { FileAccessHandler } from './config/references';
import { findConfigPath } from './config/shared';
import type { ConfigV1 } from './config/v1';
import { getPluginDependencyDiagnostic } from './dependency';
import { getLatestPackageJson } from './package-jsons';
import { detectPackageManager, type PackageManagerInfo } from './package-manager';
import { getVersionsPath } from './paths';
import {
  applyVersionUpdates,
  checkOutdatedVersions,
  checkVersionsCompleteness,
  checkVersionsConsistency,
  completeAndSyncVersions,
  readVersions,
} from './versions';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

function printBanner() {
  console.log(chalk.bold(chalk.cyan(`Fraq CLI ${chalk.green(`v${pkg.version}`)}`)));
  console.log();
}

interface EnsureConfigOptions {
  resolveAllReferences?: boolean;
  onFileAccess?: FileAccessHandler;
  recoverable?: boolean;
}

function reportOrThrow(message: string, recoverable: boolean): never {
  if (recoverable) {
    throw new Error(message);
  }
  console.error(chalk.red(message));
  process.exit(1);
}

async function ensureConfigWithVersions(options: EnsureConfigOptions & { resolveAllReferences: true }): Promise<Config>;
async function ensureConfigWithVersions(
  options?: EnsureConfigOptions & { resolveAllReferences?: false },
): Promise<DependencyConfig>;
async function ensureConfigWithVersions(options: EnsureConfigOptions = {}): Promise<Config | DependencyConfig> {
  const config = options.resolveAllReferences
    ? await loadConfig({
        resolveAllReferences: true,
        onFileAccess: options.onFileAccess,
        throwOnValidationError: options.recoverable,
      })
    : await loadConfig({
        onFileAccess: options.onFileAccess,
        throwOnValidationError: options.recoverable,
      });
  const lockfileVersions = readVersions();
  config.versions = { ...lockfileVersions, ...config.versions };

  const completeness = checkVersionsCompleteness(config, config.versions);
  if (completeness.status === 'missing') {
    if (options.recoverable) {
      reportOrThrow(
        `The following plugin versions are missing:\n${completeness.missingPlugins.map((plugin) => `- ${plugin}`).join('\n')}`,
        true,
      );
    }
    console.log(chalk.red('The following plugin versions are missing:'));
    for (const missingPlugin of completeness.missingPlugins) {
      console.log(chalk.red(`- ${missingPlugin}`));
    }
    console.log();
    console.log('Please complete the versions in the `versions` section of your configuration file.');
    console.log(
      `Alternatively, you can run ${chalk.cyan('fraq lock')} to automatically complete the versions for you.`,
    );
    process.exit(1);
  }

  const consistency = checkVersionsConsistency(config.versions, lockfileVersions);
  if (consistency.status === 'inconsistent') {
    if (options.recoverable) {
      reportOrThrow(
        `The following plugin versions are inconsistent with the lockfile:\n${consistency.inconsistentPlugins
          .map((plugin) => `- ${plugin.name}: configured ${plugin.configured}, lockfile ${plugin.lockfile}`)
          .join('\n')}`,
        true,
      );
    }
    console.log(chalk.red('The following plugin versions are inconsistent with the lockfile:'));
    for (const inconsistentPlugin of consistency.inconsistentPlugins) {
      console.log(chalk.red(`- ${inconsistentPlugin.name}`));
      console.log(chalk.red(`  Configured version: ${chalk.yellow(inconsistentPlugin.configured)}`));
      console.log(chalk.red(`  Lockfile version: ${chalk.yellow(inconsistentPlugin.lockfile)}`));
    }
    console.log();
    console.log('Please resolve the above conflicts in your configuration file or lockfile.');
    console.log(`Alternatively, you can run ${chalk.cyan('fraq lock')} to sync the lockfile automatically.`);
    process.exit(1);
  }

  return config;
}

async function ensurePackageManager(
  config: Pick<DependencyConfig, 'packageManager'>,
  options: { recoverable?: boolean } = {},
): Promise<PackageManagerInfo & { commandPath: string }> {
  let packageManager: PackageManagerInfo | undefined;
  if (config.packageManager) {
    const result = await detectPackageManager(config.packageManager);
    if (!result.installed || !result.commandPath) {
      reportOrThrow(
        `Specified package manager '${config.packageManager}' is not found in the system PATH.`,
        options.recoverable ?? false,
      );
    }
    packageManager = result;
  } else {
    // Try along pnpm -> yarn -> npm
    for (const name of ['pnpm', 'yarn', 'npm'] as const) {
      const result = await detectPackageManager(name);
      if (result.installed && result.commandPath) {
        packageManager = result;
        break;
      }
    }
  }
  if (!packageManager?.commandPath) {
    reportOrThrow(
      "No package manager found in the system PATH. Please install one of 'pnpm', 'yarn', or 'npm', or specify a package manager in the configuration.",
      options.recoverable ?? false,
    );
  }
  return { ...packageManager, commandPath: packageManager.commandPath };
}

async function start(runInstall: boolean = true): Promise<void> {
  const config = await ensureConfigWithVersions({ resolveAllReferences: true });
  const diagnostic = await getPluginDependencyDiagnostic(config);
  if (diagnostic.status === 'missing') {
    console.error(chalk.red('There are issues with the plugin dependencies:'));
    for (const issue of diagnostic.message) {
      console.error(chalk.red(`- ${issue}`));
    }
    console.error(chalk.red('Please resolve the above issues before proceeding.'));
    process.exit(1);
  }

  const exitCode = await startApp({
    config: config,
    pmInfo: await ensurePackageManager(config),
    runInstall: runInstall,
  });
  process.exit(exitCode);
}

async function lock(
  options: { onFileAccess?: FileAccessHandler; recoverable?: boolean; silent?: boolean } = {},
): Promise<boolean> {
  if (!options.silent) {
    console.log(chalk.cyan('Syncing lockfile versions...'));
  }
  const config = await loadConfig({
    onFileAccess: options.onFileAccess,
    throwOnValidationError: options.recoverable,
  });
  const lockfileVersions = readVersions();
  config.versions = { ...lockfileVersions, ...config.versions };
  const completedVersions = await completeAndSyncVersions(config, config.versions);
  const changed = !isDeepStrictEqual(lockfileVersions, completedVersions);
  if (changed) {
    writeFileSync(getVersionsPath(), YAML.stringify(completedVersions));
  }
  if (!options.silent) {
    console.log(chalk.green('Successfully synced lockfile versions.'));
  }
  return changed;
}

async function watch(): Promise<void> {
  const configPath = findConfigPath();
  const versionsPath = getVersionsPath();
  const exitCode = await startWatchedApp({
    initialFiles: [configPath, versionsPath],
    prepare: async (accessedFiles) => {
      const onFileAccess = (filePath: string) => accessedFiles.add(filePath);
      await lock({ onFileAccess, recoverable: true, silent: true });
      const config = await ensureConfigWithVersions({
        resolveAllReferences: true,
        onFileAccess,
        recoverable: true,
      });
      const diagnostic = await getPluginDependencyDiagnostic(config);
      if (diagnostic.status === 'missing') {
        throw new Error(`There are issues with the plugin dependencies:\n${diagnostic.message.join('\n')}`);
      }
      return {
        config,
        packageManager: await ensurePackageManager(config, { recoverable: true }),
      };
    },
  });
  process.exit(exitCode);
}

async function installOnly() {
  const config = await ensureConfigWithVersions();
  const pmInfo = await ensurePackageManager(config);
  const exitCode = await startInstall(pmInfo);
  process.exit(exitCode);
}

async function outdated() {
  const config = await ensureConfigWithVersions();
  const outdated = await checkOutdatedVersions(config.fraqVersion, config.versions);
  if (outdated.outdated.length === 0 && outdated.errors.length === 0) {
    console.log(chalk.green('All versions are up to date.'));
    return;
  }
  if (outdated.outdated.length > 0) {
    console.log(chalk.yellow('The following versions have newer releases available:'));
    for (const { name, current, latest } of outdated.outdated) {
      console.log(`- ${name}: current ${chalk.red(current)} -> latest ${chalk.green(latest)}`);
    }
  }
  if (outdated.errors.length > 0) {
    console.log(chalk.red('Failed to check the following versions:'));
    for (const { name, error } of outdated.errors) {
      console.log(`- ${name}:`, error);
    }
  }
}

async function update() {
  const config = await ensureConfigWithVersions();
  const result = await checkOutdatedVersions(config.fraqVersion, config.versions);
  if (result.errors.length > 0) {
    console.log(chalk.red('Failed to check the following versions:'));
    for (const { name, error } of result.errors) {
      console.log(`- ${name}:`, error);
    }
  }
  if (result.outdated.length === 0) {
    if (result.errors.length === 0) {
      console.log(chalk.green('All Fraq and plugin versions are up to date.'));
    }
    return;
  }

  const selectedIndexes = await inq.checkbox<number>({
    message: 'Select versions to update:',
    choices: result.outdated.map(({ name, current, latest }, index) => ({
      name: `${name}: ${current} -> ${latest}`,
      value: index,
    })),
    required: true,
  });
  const selectedVersions = selectedIndexes
    .map((index) => result.outdated[index])
    .filter((version) => version !== undefined);

  const pluginVersions: Record<string, string> = Object.create(null);
  let fraqVersion: string | undefined;
  for (const version of selectedVersions) {
    if (version.type === 'fraq') {
      fraqVersion = version.latest;
    } else {
      pluginVersions[version.name] = version.latest;
    }
  }
  applyVersionUpdates({ fraqVersion, pluginVersions });

  console.log(chalk.green('Successfully updated the following versions:'));
  for (const { name, current, latest } of selectedVersions) {
    console.log(`- ${name}: ${current} -> ${latest}`);
  }
}

async function wizard() {
  const latestFraqVersion: string = (await getLatestPackageJson('@fraqjs/fraq')).version;
  const projectName = await inq.input({
    message: 'Project name:',
    default: 'my-fraq-app',
  });
  const fraqVersion = await inq.input({
    message: 'Fraq version to use:',
    default: latestFraqVersion,
  });
  const milkyAddress = await inq.input({
    message: 'Milky server address:',
    default: 'localhost',
  });
  const milkyPort = await inq.number({
    message: 'Milky server port:',
    default: 30001,
  });
  console.log();

  const yaml = YAML.stringify({
    configVersion: 1,
    fraqVersion: fraqVersion,
    milky: {
      url: `http://${milkyAddress}:${milkyPort}/`,
    },
  } satisfies z.input<typeof ConfigV1>);
  console.log(`Fraq CLI is going to create ${chalk.cyan(`${projectName}/fraq.yml`)} with the following content:`);
  console.log();
  console.log(yaml);

  const ok = await inq.confirm({
    message: 'Is it ok?',
  });

  console.log();
  if (!ok) {
    console.log(chalk.red('Wizard aborted.'));
    process.exit(1);
  }
  mkdirSync(projectName, { recursive: true });
  writeFileSync(path.resolve(projectName, 'fraq.yml'), yaml, 'utf-8');
  console.log(chalk.green('Configuration file created successfully.'));
  console.log();
  console.log('Please run:');
  console.log(chalk.cyan(`cd ${projectName}`));
  console.log(chalk.cyan('fraq start'));
  console.log('to start your Fraq application.');
}

const cli = c.subcommands({
  name: 'fraq',
  cmds: {
    start: c.command({
      name: 'start',
      description: 'Start the Fraq application',
      aliases: ['run'],
      args: {
        noInstall: c.flag({
          long: 'no-install',
          description: 'Skip installing dependencies before starting the application',
        }),
        frozenLockfile: c.flag({
          long: 'frozen-lockfile',
          description: 'Use the frozen lockfile, i.e. no automatic locking, when starting the application',
        }),
        watch: c.flag({
          long: 'watch',
          description: 'Restart the Fraq application when configuration sources change',
        }),
      },
      handler: async ({ noInstall, frozenLockfile, watch: watchEnabled }) => {
        printBanner();
        if (watchEnabled && (noInstall || frozenLockfile)) {
          console.error(chalk.red('--watch cannot be used with --no-install or --frozen-lockfile.'));
          process.exit(1);
        }
        if (watchEnabled) {
          await watch();
          return;
        }
        if (!frozenLockfile) {
          await lock();
          console.log();
        }
        await start(!noInstall);
      },
    }),
    lock: c.command({
      name: 'lock',
      description: 'Automatically complete the versions of plugins in the configuration file',
      args: {},
      handler: async () => {
        printBanner();
        await lock();
      },
    }),
    install: c.command({
      name: 'install',
      description: 'Install dependencies without starting the application',
      aliases: ['i'],
      args: {},
      handler: async () => {
        printBanner();
        await installOnly();
      },
    }),
    outdated: c.command({
      name: 'outdated',
      description: 'Check for outdated Fraq and plugin versions',
      args: {},
      handler: async () => {
        printBanner();
        await outdated();
      },
    }),
    update: c.command({
      name: 'update',
      description: 'Update Fraq and plugin versions interactively',
      aliases: ['upgrade', 'up'],
      args: {},
      handler: async () => {
        printBanner();
        await update();
      },
    }),
    wizard: c.command({
      name: 'wizard',
      description: 'Initialize a fraq.yml through a wizard',
      aliases: ['init', 'setup'],
      args: {},
      handler: async () => {
        printBanner();
        await wizard();
      },
    }),
    version: c.command({
      name: 'version',
      aliases: ['v'],
      description: 'Show the version of Fraq CLI',
      args: {},
      handler: () => {
        console.log(pkg.version);
      },
    }),
  },
});

c.run(cli, process.argv.slice(2));
