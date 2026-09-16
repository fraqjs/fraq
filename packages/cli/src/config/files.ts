import {
  type ConfigChanges,
  type ConfigFile,
  ControlError,
  MAX_CONFIG_BYTES,
  MAX_CONFIG_FILES,
  MAX_CONFIG_TOTAL_BYTES,
} from '@fraqjs/cli-protocol';

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

interface FileRecord {
  id: string;
  path: string;
  target?: string;
  paths: Set<string>;
  signature: string;
  kind: 'tree' | 'text';
  structuredPath?: string;
  bytes?: Buffer;
  content?: string;
  mode?: number;
  reason?: string;
}

export interface FileEdit {
  target: string;
  paths: string[];
  content: string;
  original: Buffer;
  mode: number;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class FileRegistry {
  readonly root: string;
  private readonly mainTarget: string;
  private readonly files = new Map<string, FileRecord>();
  private readonly paths = new Map<string, FileRecord>();
  private bytes = 0;

  constructor(readonly mainPath: string) {
    this.mainTarget = realpathSync(mainPath);
    this.root = path.dirname(this.mainTarget);
    this.access(mainPath, 'tree');
  }

  access(filePath: string, kind: 'tree' | 'text' = 'tree'): void {
    const file = path.resolve(filePath);
    const known = this.paths.get(file);
    if (known) {
      if (kind === 'tree') {
        known.kind = kind;
        known.structuredPath ??= file;
      }
      return;
    }
    let target: string | undefined;
    try {
      target = realpathSync(file);
    } catch {}
    const key = target ?? file;
    const existing = this.files.get(key);
    if (existing) {
      existing.paths.add(file);
      this.paths.set(file, existing);
      if (kind === 'tree') {
        existing.kind = kind;
        existing.structuredPath ??= file;
      }
      return;
    }
    if (this.files.size >= MAX_CONFIG_FILES) throw new ControlError('invalid', '引用文件数量超过 128 个。');
    const record: FileRecord = {
      id: createHash('sha256').update(key).digest('hex'),
      path: file,
      target,
      paths: new Set([file]),
      signature: 'unavailable',
      kind,
      structuredPath: kind === 'tree' ? file : undefined,
    };
    this.files.set(key, record);
    this.paths.set(file, record);
    try {
      if (!target) throw new Error('文件不存在或无法访问。');
      const stat = statSync(target);
      record.signature = `${target}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (!stat.isFile()) throw new Error('不是普通文件。');
      if (stat.size > MAX_CONFIG_BYTES) throw new Error('文件超过 1 MiB，无法在线编辑。');
      if (this.bytes + stat.size > MAX_CONFIG_TOTAL_BYTES) throw new Error('引用内容合计超过 4 MiB，无法在线编辑。');
      const bytes = readFileSync(target);
      if (bytes.length > MAX_CONFIG_BYTES || this.bytes + bytes.length > MAX_CONFIG_TOTAL_BYTES) {
        throw new Error('文件内容超过大小限制。');
      }
      if (realpathSync(file) !== target) throw new Error('文件路径在读取期间发生变化。');
      this.bytes += bytes.length;
      record.bytes = bytes;
      record.mode = stat.mode & 0o777;
      record.signature += `:${createHash('sha256').update(bytes).digest('hex')}`;
      try {
        record.content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new Error('仅支持 UTF-8 文本文件。');
      }
      if (bytes.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
        record.content = undefined;
        throw new Error('文件包含二进制内容。');
      }
    } catch (error) {
      record.reason = error instanceof Error && !('code' in error) ? error.message : '文件不存在或无法读取。';
    }
  }

  read(filePath: string): string {
    this.access(filePath, 'text');
    const record = this.paths.get(path.resolve(filePath));
    if (record?.content === undefined || record.reason) throw new Error('无法读取引用文件。');
    return record.content;
  }

  get revision(): string {
    const hash = createHash('sha256').update(this.mainPath).update(this.root);
    for (const [file, record] of [...this.paths].sort(([a], [b]) => a.localeCompare(b))) {
      hash.update(JSON.stringify([file, record.target, record.signature]));
    }
    return hash.digest('hex');
  }

  unchanged(): boolean {
    try {
      const current = new FileRegistry(this.mainPath);
      for (const [file, record] of this.paths) current.access(file, record.kind);
      return current.revision === this.revision;
    } catch {
      return false;
    }
  }

  validateBudget(contents: ReadonlyMap<string, string>): void {
    let total = 0;
    for (const record of this.files.values()) {
      const content = record.target ? contents.get(record.target) : undefined;
      total += content === undefined ? (record.bytes?.length ?? 0) : Buffer.byteLength(content);
    }
    if (total > MAX_CONFIG_TOTAL_BYTES) throw new ControlError('invalid', '配置与引用内容合计不能超过 4 MiB。');
  }

  list(): ConfigFile[] {
    return [...this.files.values()].map((record) => {
      const target = record.target ?? record.path;
      const main = record.target === this.mainTarget;
      const name = path.relative(this.root, target).split(path.sep).join('/');
      const structuredPath = record.structuredPath ?? target;
      const format = record.kind === 'text' ? 'text' : structuredPath.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
      const info = { id: record.id, name, format, main } as const;
      const reason = !main && !inside(this.root, target) ? '超出编辑范围' : record.reason;
      if (reason || record.content === undefined)
        return { ...info, editable: false, reason: reason ?? '无法读取文件。' };
      return { ...info, editable: true, content: record.content };
    });
  }

  edits(changes: ConfigChanges['files']): FileEdit[] {
    const allowed = new Map(this.list().map((file) => [file.id, file]));
    const records = new Map([...this.files.values()].map((record) => [record.id, record]));
    const seen = new Set<string>();
    let bytes = 0;
    return changes.map(({ id, content }) => {
      const file = allowed.get(id);
      const record = records.get(id);
      if (!file?.editable || !record?.target || !record.bytes || record.mode === undefined || seen.has(id)) {
        throw new ControlError('invalid', '文件不可编辑、已移出引用范围或被重复提交，请重新读取。');
      }
      seen.add(id);
      const encoded = Buffer.from(content);
      if (
        encoded.toString('utf8') !== content ||
        encoded.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)
      ) {
        throw new ControlError('invalid', '只能保存有效的 UTF-8 文本。');
      }
      const size = encoded.length;
      bytes += size;
      if (size > MAX_CONFIG_BYTES || bytes > MAX_CONFIG_TOTAL_BYTES) {
        throw new ControlError('invalid', '单文件不能超过 1 MiB，保存内容合计不能超过 4 MiB。');
      }
      return { target: record.target, paths: [...record.paths], content, original: record.bytes, mode: record.mode };
    });
  }
}
