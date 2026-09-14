import chalk from 'chalk';

import type { Config } from '../config';
import type { PackageManagerInfo } from '../package-manager';
import { getAppPath } from '../paths';
import { generateAppPackageJson } from './package-json';
import { installAppDependencies } from './runner';
import { buildStartScript } from './start-script';

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Runtime {
  directory: string;
  entryPoint: string;
  startScript: string;
  fingerprint: string;
}

export interface RuntimeOptions {
  refresh: boolean;
}

export interface RuntimeStore {
  prepare(
    config: Config,
    packageManager: PackageManagerInfo & { commandPath: string },
    options: RuntimeOptions,
  ): Promise<Runtime>;
  close(): void;
}

export function dependencyFingerprint(config: Config, packageManager: PackageManagerInfo): string {
  const dependencies = Object.entries(generateAppPackageJson(config).dependencies).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify({ packageManager: packageManager.name, dependencies });
}

// Owns immutable startup scripts and dependency installations. Installing a candidate
// must never modify the dependency directory used by the last successful runtime.
export class RuntimeRegistry implements RuntimeStore {
  private installed?: Runtime;
  private readonly directories = new Set<string>();

  constructor(
    private readonly appPath = getAppPath(),
    private readonly install = installAppDependencies,
  ) {}

  async prepare(
    config: Config,
    packageManager: PackageManagerInfo & { commandPath: string },
    options: RuntimeOptions,
  ): Promise<Runtime> {
    const startScript = buildStartScript(config);
    const fingerprint = dependencyFingerprint(config, packageManager);
    const reusable = !options.refresh && this.installed?.fingerprint === fingerprint ? this.installed : undefined;
    const directory = reusable?.directory ?? path.join(this.appPath, 'runtimes', randomUUID());
    if (!reusable) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.directories.add(directory);
    }

    const entryPoint = path.join(directory, `start-${randomUUID()}.mjs`);
    try {
      writeFileSync(entryPoint, startScript, { mode: 0o600 });
      if (!reusable) {
        const packageJson = generateAppPackageJson(config, directory);
        writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
        console.log(chalk.cyan(`Installing application dependencies with ${packageManager.name}...`));
        const result = await this.install(packageManager, directory);
        if (result !== 0) {
          throw new Error(`Package manager install failed with exit code ${result}.`);
        }
      }
      const runtime = { directory, entryPoint, startScript, fingerprint };
      this.installed = runtime;
      return runtime;
    } catch (error) {
      if (!reusable) {
        rmSync(directory, { recursive: true, force: true });
        this.directories.delete(directory);
      } else {
        rmSync(entryPoint, { force: true });
      }
      throw error;
    }
  }

  close(): void {
    for (const directory of this.directories) {
      rmSync(directory, { recursive: true, force: true });
    }
    this.directories.clear();
    this.installed = undefined;
  }
}
