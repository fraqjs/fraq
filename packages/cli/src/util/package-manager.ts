import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';

export type PackageManagerName = 'npm' | 'yarn' | 'pnpm';

export interface PackageManagerInfo {
  name: PackageManagerName;
  installed: boolean;
  /** The entry with the highest priority in PATH, which is currently effective */
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

function readVersion(commandPath: string): {
  version?: string;
  error?: string;
} {
  /*
   * Windows 无法像普通 .exe 一样直接执行 npm.cmd/yarn.cmd/pnpm.cmd，
   * 因此需要通过 cmd.exe 执行。
   */
  const result =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${commandPath}" --version`], {
          encoding: 'utf8',
          windowsHide: true,
        })
      : spawnSync(commandPath, ['--version'], {
          encoding: 'utf8',
        });

  if (result.error) {
    return { error: result.error.message };
  }

  const stdout = result.stdout?.trim();
  const stderr = result.stderr?.trim();

  if (result.status !== 0) {
    return {
      error: stderr || stdout || `命令退出码为 ${result.status ?? 'unknown'}`,
    };
  }

  const version = stdout || stderr;

  if (!version) {
    return { error: '命令执行成功，但没有输出版本号' };
  }

  return {
    // 正常情况下只有一行；取第一行避免额外提示信息干扰。
    version: version.split(/\r?\n/, 1)[0].trim(),
  };
}

export function detectPackageManager(name: PackageManagerName): PackageManagerInfo {
  const allCommandPaths = findExecutablesOnPath(name);
  const commandPath = allCommandPaths[0];

  if (!commandPath) {
    return {
      name,
      installed: false,
      allCommandPaths,
    };
  }

  let realPath = commandPath;

  try {
    realPath = realpathSync.native(commandPath);
  } catch {
    // 某些虚拟文件系统或 Windows shim 可能无法解析，保留原路径。
  }

  const versionResult = readVersion(commandPath);

  return {
    name,
    installed: versionResult.version !== undefined,
    commandPath,
    realPath,
    version: versionResult.version,
    allCommandPaths,
    error: versionResult.error,
  };
}
