import { type ConfigChanges, type ConfigDocument, type ConfigWorkspace, ControlError } from '@fraqjs/cli-protocol';
import z from 'zod';

import { type FileEdit, FileRegistry } from './files';
import { parseConfigText } from './references';
import { findConfigPath } from './shared';
import { ConfigV1 } from './v1';

import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class ConfigEditor {
  constructor(private readonly replaceFile = renameSync) {}

  private scan(): { registry: FileRegistry; workspace: ConfigWorkspace } {
    const registry = new FileRegistry(findConfigPath());
    let failed = false;
    try {
      const resolved = parseConfigText(registry.read(registry.mainPath), registry.mainPath, {
        onFileAccess: (file, kind) => registry.access(file, kind),
        readFile: (file) => registry.read(file),
        onError: () => {
          failed = true;
        },
      });
      if (!ConfigV1.safeParse(resolved).success) failed = true;
    } catch {
      failed = true;
    }
    return {
      registry,
      workspace: {
        root: registry.root,
        revision: registry.revision,
        files: registry.list(),
        ...(failed ? { error: '配置或引用存在错误，请修复后保存。' } : {}),
      },
    };
  }

  list(): ConfigWorkspace {
    return this.scan().workspace;
  }

  read(): ConfigDocument {
    const workspace = this.list();
    const main = workspace.files.find((file) => file.main);
    if (!main?.editable || main.format === 'text') throw new ControlError('invalid', '主配置无法在线编辑。');
    return { name: main.name, format: main.format, content: main.content, revision: workspace.revision };
  }

  save(content: string, revision: string): ConfigDocument {
    const main = this.list().files.find((file) => file.main);
    if (!main) throw new ControlError('invalid', '找不到主配置。');
    this.saveFiles({ revision, files: [{ id: main.id, content }] });
    return this.read();
  }

  saveFiles(changes: ConfigChanges): ConfigWorkspace {
    const { registry, workspace } = this.scan();
    if (workspace.revision !== changes.revision)
      throw new ControlError('conflict', '配置或引用文件已被修改，请重新读取后再保存。');
    const edits = registry.edits(changes.files);
    if (!edits.length) throw new ControlError('invalid', '没有需要保存的文件。');
    const overlays = new Map(edits.map((edit) => [edit.target, edit.content]));
    const validation = new FileRegistry(registry.mainPath);
    let resolved: unknown;
    try {
      resolved = parseConfigText(
        overlays.get(realpathSync(registry.mainPath)) ?? registry.read(registry.mainPath),
        registry.mainPath,
        {
          onFileAccess: (file, kind) => validation.access(file, kind),
          readFile: (file) => overlays.get(realpathSync(file)) ?? validation.read(file),
        },
      );
    } catch {
      // Parser errors can contain excerpts from references outside the editable directory.
      throw new ControlError('invalid', '无法解析配置或引用文件，请检查语法、引用路径和环境变量。');
    }
    validation.validateBudget(overlays);
    const result = ConfigV1.safeParse(resolved);
    if (!result.success) {
      const outside = validation.list().some((file) => !file.editable && file.reason === '超出编辑范围');
      throw new ControlError('invalid', outside ? '配置字段类型或结构不符合要求。' : z.prettifyError(result.error));
    }

    const staged: (FileEdit & { temporary: string; backup: string; committed: boolean })[] = [];
    let preserveBackups = false;
    try {
      for (const edit of edits) {
        const prefix = path.join(path.dirname(edit.target), `.${path.basename(edit.target)}.${randomUUID()}`);
        const entry = {
          ...edit,
          temporary: `${prefix}.tmp`,
          backup: `${prefix}.bak`,
          committed: false,
        };
        staged.push(entry);
        writeFileSync(entry.temporary, edit.content, { mode: edit.mode, flag: 'wx' });
        writeFileSync(entry.backup, edit.original, { mode: edit.mode, flag: 'wx' });
        chmodSync(entry.temporary, edit.mode);
        chmodSync(entry.backup, edit.mode);
      }
      if (findConfigPath() !== registry.mainPath || !registry.unchanged() || !validation.unchanged()) {
        throw new ControlError('conflict', '保存期间配置或引用文件发生变化。');
      }
      // No await: watcher callbacks cannot start a reload between these replacements.
      for (const edit of staged) {
        if (
          edit.paths.some((file) => realpathSync(file) !== edit.target) ||
          !readFileSync(edit.target).equals(edit.original)
        ) {
          throw new ControlError('conflict', '保存期间文件或符号链接发生变化。');
        }
        this.replaceFile(edit.temporary, edit.target);
        edit.committed = true;
      }
    } catch (error) {
      for (const entry of staged.filter((entry) => entry.committed).reverse()) {
        try {
          if (realpathSync(entry.target) !== entry.target || readFileSync(entry.target, 'utf8') !== entry.content)
            throw new Error('changed');
          this.replaceFile(entry.backup, entry.target);
        } catch {
          preserveBackups = true;
        }
      }
      if (preserveBackups)
        throw new ControlError(
          'internal',
          '保存失败且无法完整恢复；原文件备份保留在同目录的 .bak 文件中，请通过终端处理。',
        );
      if (error instanceof ControlError) throw error;
      throw new ControlError('internal', '文件写入失败，已恢复原内容。');
    } finally {
      for (const entry of staged) {
        rmSync(entry.temporary, { force: true });
        if (!preserveBackups) rmSync(entry.backup, { force: true });
      }
    }
    return this.list();
  }
}
