import { execa } from 'execa';

import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';

const versionCheckTimeout = 5_000;

export type PackageManagerName = 'npm' | 'yarn' | 'pnpm';

export interface PackageManagerInfo {
  name: PackageManagerName;
  installed: boolean;
  /** The first entry in PATH that passed version validation */
  commandPath?: string;
  /** The path after resolving symbolic links, such as the actual file in Corepack, Volta, or nvm */
  realPath?: string;
  version?: string;
  /** All candidate entries found in PATH */
  allCommandPaths: string[];
  error?: string;
}

function findExecutablesOnPath(command: string): string[] {
  const pathValue = process.env.PATH ?? '';
  const directories = pathValue.split(path.delimiter);
  const executableNames =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((extension) => `${command}${extension.toLowerCase()}`)
      : [command];
  const results: string[] = [];
  const seen = new Set<string>();

  for (const rawDirectory of directories) {
    let directory = rawDirectory.trim();
    if (directory.startsWith('"') && directory.endsWith('"')) {
      directory = directory.slice(1, -1);
    }
    directory = directory || process.cwd();

    for (const executableName of executableNames) {
      const candidate = path.resolve(directory, executableName);

      try {
        const stats = statSync(candidate);
        if (!stats.isFile()) {
          continue;
        }
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      } catch {
        continue;
      }

      // Windows file paths are case-insensitive.
      const deduplicationKey = process.platform === 'win32' ? candidate.toLowerCase() : candidate;

      if (!seen.has(deduplicationKey)) {
        seen.add(deduplicationKey);
        results.push(candidate);
      }
    }
  }

  return results;
}

async function readVersion(commandPath: string): Promise<{
  version?: string;
  error?: string;
}> {
  const result = await execa(commandPath, ['--version'], {
    forceKillAfterDelay: 1_000,
    killDescendants: true,
    lines: true,
    reject: false,
    timeout: versionCheckTimeout,
  });

  if (result.failed) {
    if (result.timedOut) {
      return { error: `Version check timed out after ${versionCheckTimeout}ms` };
    }
    return {
      error:
        result.exitCode === undefined
          ? `Cannot run version check${typeof result.code === 'string' ? ` (${result.code})` : ''}`
          : `Version check exited with code ${result.exitCode}`,
    };
  }

  const version = [...result.stdout, ...result.stderr].map((line) => line.trim()).find(Boolean);

  if (!version) {
    return { error: 'Command succeeded but produced no version output' };
  }

  return { version };
}

export async function detectPackageManager(name: PackageManagerName): Promise<PackageManagerInfo> {
  const allCommandPaths = findExecutablesOnPath(name);

  const errors: string[] = [];
  for (const commandPath of allCommandPaths) {
    const versionResult = await readVersion(commandPath);
    if (!versionResult.version) {
      errors.push(`${commandPath}: ${versionResult.error ?? 'Version check failed'}`);
      continue;
    }

    let realPath = commandPath;
    try {
      realPath = realpathSync.native(commandPath);
    } catch {
      // Some virtual filesystems or Windows shims may not be resolvable; keep the original path.
    }

    return {
      name,
      installed: true,
      commandPath,
      realPath,
      version: versionResult.version,
      allCommandPaths,
    };
  }

  return {
    name,
    installed: false,
    allCommandPaths,
    error: errors.length > 0 ? errors.join('\n') : undefined,
  };
}
