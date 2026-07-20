#!/usr/bin/env node

import chalk from 'chalk';
import * as c from 'cmd-ts';
import YAML from 'yaml';

import pkg from '../package.json';
import { startApp, startInstall } from './app';
import type { Config } from './config';
import { loadConfig } from './config';
import { getVersionsPath } from './paths';
import { getPluginDependencyDiagnostic } from './util/dependency';
import { detectPackageManager, type PackageManagerInfo } from './util/package-manager';
import {
  checkVersionsCompleteness,
  checkVersionsConsistency,
  completePluginVersions,
  readVersions,
} from './util/versions';

import { writeFileSync } from 'node:fs';

async function ensureConfigWithVersions(): Promise<Config> {
  const config = await loadConfig();
  const lockfileVersions = readVersions();
  config.versions = { ...lockfileVersions, ...config.versions };

  const completeness = checkVersionsCompleteness(config, config.versions);
  if (completeness.status === 'missing') {
    console.log(chalk.red('The following plugin versions are missing:'));
    for (const missingPlugin of completeness.missingPlugins) {
      console.log(chalk.red(`- ${missingPlugin}`));
    }
    console.log();
    console.log('Please complete the versions in the `versions` section of your configuration file.');
    console.log(
      'Alternatively, you can run',
      chalk.cyan('fraq lock'),
      'to automatically complete the versions for you.',
    );
    process.exit(1);
  }

  const consistency = checkVersionsConsistency(config.versions, lockfileVersions);
  if (consistency.status === 'inconsistent') {
    console.log(chalk.red('The following plugin versions are inconsistent with the lockfile:'));
    for (const inconsistentPlugin of consistency.inconsistentPlugins) {
      console.log(chalk.red(`- ${inconsistentPlugin.name}`));
      console.log(chalk.red(`  Configured version: ${chalk.yellow(inconsistentPlugin.configured)}`));
      console.log(chalk.red(`  Lockfile version: ${chalk.yellow(inconsistentPlugin.lockfile)}`));
    }
    console.log();
    console.log('Please resolve the above conflicts in your configuration file or lockfile.');
    console.log(
      'Alternatively, you can run',
      chalk.cyan('fraq lock'),
      'to align the lockfile versions to your configuration automatically.',
    );
    process.exit(1);
  }

  return config;
}

function ensurePackageManager(config: Config): PackageManagerInfo & { commandPath: string } {
  let packageManager: PackageManagerInfo | undefined;
  if (config.packageManager) {
    const result = detectPackageManager(config.packageManager);
    if (!result?.installed || !result?.commandPath) {
      console.error(chalk.red(`Specified package manager '${config.packageManager}' is not found in the system PATH.`));
      process.exit(1);
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
    console.error(
      chalk.red(
        "No package manager found in the system PATH. Please install one of 'pnpm', 'yarn', or 'npm', or specify a package manager in the configuration.",
      ),
    );
    process.exit(1);
  }
  return { ...packageManager, commandPath: packageManager.commandPath };
}

async function lock() {
  const config = await loadConfig();
  const lockfileVersions = readVersions();
  config.versions = { ...lockfileVersions, ...config.versions };
  const completeness = checkVersionsCompleteness(config, config.versions);
  const consistency = checkVersionsConsistency(config.versions, lockfileVersions);
  if (completeness.status === 'ok' && consistency.status === 'ok') {
    console.log(chalk.green('Nothing to do since all plugin versions are already complete and aligned.'));
    return;
  }
  const completedVersions = await completePluginVersions(config, config.versions);
  writeFileSync(getVersionsPath(), YAML.stringify(completedVersions));
  console.log(chalk.green('Successfully completed the plugin versions in versions.yml.'));
}

async function main(runInstall: boolean = true): Promise<void> {
  const config = await ensureConfigWithVersions();
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
    pmInfo: ensurePackageManager(config),
    runInstall: runInstall,
  });
  process.exit(exitCode);
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
      },
      handler: async ({ noInstall, frozenLockfile }) => {
        if (!frozenLockfile) {
          await lock();
        }
        await main(!noInstall);
      },
    }),
    lock: c.command({
      name: 'lock',
      description: 'Automatically complete the versions of plugins in the configuration file',
      args: {},
      handler: async () => {
        await lock();
      },
    }),
    install: c.command({
      name: 'install',
      description: 'Install dependencies without starting the application',
      aliases: ['i'],
      args: {},
      handler: async () => {
        const config = await ensureConfigWithVersions();
        const pmInfo = ensurePackageManager(config);
        const exitCode = await startInstall(pmInfo);
        process.exit(exitCode);
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
