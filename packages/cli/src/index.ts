#!/usr/bin/env node

import chalk from 'chalk';
import * as c from 'cmd-ts';

import pkg from '../package.json';
import { startApp } from './app';
import { loadConfig } from './config';
import { getPluginDependencyDiagnostic } from './dependency';
import { detectPackageManager, type PackageManagerInfo } from './package-manager';

async function main() {
  const config = await loadConfig();

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

  const diagnostic = await getPluginDependencyDiagnostic(config);
  if (diagnostic.status === 'missing') {
    console.error(chalk.red('There are issues with the plugin dependencies:'));
    for (const issue of diagnostic.message) {
      console.error(chalk.red(`- ${issue}`));
    }
    console.error(chalk.red('Please resolve the above issues before proceeding.'));
    process.exit(1);
  }

  const exitCode = await startApp(config, {
    name: packageManager.name,
    commandPath: packageManager.commandPath,
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
      args: {},
      handler: async () => {
        await main();
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
