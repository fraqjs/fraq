#!/usr/bin/env node

import * as inq from '@inquirer/prompts';
import chalk from 'chalk';
import * as c from 'cmd-ts';
import YAML from 'yaml';
import type z from 'zod';

import pkg from '../package.json';
import { prepareApp, startApp, startInstall, startWatchedApp, syncVersions } from './app';
import { loadProjectConfig } from './config';
import { getConfigPaths } from './config/shared';
import type { ConfigV1 } from './config/v1';
import { getLatestPackageJson } from './package-jsons';
import { selectPackageManager } from './package-manager';
import { getVersionsPath } from './paths';
import { applyVersionUpdates, checkOutdatedVersions } from './versions';
import { getNpmPluginVersions } from './workspace-plugins';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function printBanner() {
  console.log(chalk.bold(chalk.cyan(`Fraq CLI ${chalk.green(`v${pkg.version}`)}`)));
  console.log();
}

async function start(runInstall = true, frozenLockfile = false): Promise<void> {
  try {
    const prepared = await prepareApp({ frozenLockfile });
    const exitCode = await startApp({
      config: prepared.config,
      pmInfo: prepared.packageManager,
      runInstall,
    });
    process.exit(exitCode);
  } catch (error) {
    console.error(
      chalk.red(`Failed to start the Fraq application:\n${error instanceof Error ? error.message : String(error)}`),
    );
    process.exit(1);
  }
}

async function watch(): Promise<void> {
  const exitCode = await startWatchedApp({
    initialFiles: [...getConfigPaths(), getVersionsPath()],
    prepare: (files) => prepareApp({ watch: true }, files),
  });
  process.exit(exitCode);
}

async function installOnly() {
  const config = await loadProjectConfig({ resolveAllReferences: true });
  const pmInfo = await selectPackageManager(config.packageManager);
  const exitCode = await startInstall(config, pmInfo);
  process.exit(exitCode);
}

async function outdated() {
  const config = await loadProjectConfig();
  const outdated = await checkOutdatedVersions(config.fraqVersion, getNpmPluginVersions(config));
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
  const config = await loadProjectConfig();
  const result = await checkOutdatedVersions(config.fraqVersion, getNpmPluginVersions(config));
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
        await start(!noInstall, frozenLockfile);
      },
    }),
    lock: c.command({
      name: 'lock',
      description: 'Automatically complete the versions of plugins in the configuration file',
      args: {},
      handler: async () => {
        printBanner();
        await syncVersions();
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

c.run(cli, process.argv.slice(2)).catch((error: unknown) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
