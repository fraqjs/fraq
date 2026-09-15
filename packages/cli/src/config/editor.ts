import { type ConfigDocument, ControlError, MAX_CONFIG_BYTES } from '@fraqjs/cli-protocol';
import z from 'zod';

import { parseConfigText } from './references';
import { findConfigPath } from './shared';
import { ConfigV1 } from './v1';

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class ConfigEditor {
  read(): ConfigDocument {
    const file = findConfigPath();
    if (statSync(file).size > MAX_CONFIG_BYTES) throw new ControlError('invalid', '配置文件超过 1 MiB，无法在线编辑。');
    const content = readFileSync(file, 'utf8');
    const revision = createHash('sha256').update(realpathSync(file)).update('\0').update(content).digest('hex');
    return { name: path.basename(file), format: file.endsWith('.json') ? 'json' : 'yaml', content, revision };
  }

  save(content: string, revision: string): ConfigDocument {
    if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new ControlError('invalid', '配置文件不能超过 1 MiB。');
    if (this.read().revision !== revision)
      throw new ControlError('conflict', '配置已被其他操作修改，请重新读取后再保存。');
    const file = findConfigPath();
    try {
      const result = ConfigV1.safeParse(parseConfigText(content, file));
      if (!result.success) throw new Error(z.prettifyError(result.error));
    } catch (error) {
      throw new ControlError('invalid', error instanceof Error ? error.message : String(error));
    }
    const target = realpathSync(file);
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { mode: statSync(target).mode & 0o777, flag: 'wx' });
      if (this.read().revision !== revision || realpathSync(findConfigPath()) !== target) {
        throw new ControlError('conflict', '保存期间配置发生变化，请重新读取。');
      }
      renameSync(temporary, target);
      return this.read();
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
