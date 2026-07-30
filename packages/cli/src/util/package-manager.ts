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

      // Windows 文件路径不区分大小写。
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
      return { error: `版本检查在 ${versionCheckTimeout}ms 后超时` };
    }
    return {
      error:
        result.exitCode === undefined
          ? `无法执行版本检查${typeof result.code === 'string' ? ` (${result.code})` : ''}`
          : `版本检查退出码为 ${result.exitCode}`,
    };
  }

  const version = [...result.stdout, ...result.stderr].map((line) => line.trim()).find(Boolean);

  if (!version) {
    return { error: '命令执行成功，但没有输出版本号' };
  }

  return { version };
}

export async function detectPackageManager(name: PackageManagerName): Promise<PackageManagerInfo> {
  const allCommandPaths = findExecutablesOnPath(name);

  const errors: string[] = [];
  for (const commandPath of allCommandPaths) {
    const versionResult = await readVersion(commandPath);
    if (!versionResult.version) {
      errors.push(`${commandPath}: ${versionResult.error ?? '版本检查失败'}`);
      continue;
    }

    let realPath = commandPath;
    try {
      realPath = realpathSync.native(commandPath);
    } catch {
      // 某些虚拟文件系统或 Windows shim 可能无法解析，保留原路径。
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
