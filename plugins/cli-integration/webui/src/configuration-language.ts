import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { indentUnit } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { ConfigDocument } from '@fraqjs/cli-protocol';

export function configurationLanguage(format: ConfigDocument['format'], content: string) {
  const indents = [...content.matchAll(/^(\t+| +)\S/gm)].map((match) => match[1]);
  const spaces = indents.filter((indent) => indent.startsWith(' ')).map((indent) => indent.length);
  const unit = indents.some((indent) => indent.startsWith('\t'))
    ? '\t'
    : ' '.repeat(spaces.length ? spaces.reduce((minimum, width) => Math.min(minimum, width)) : 2);

  return [
    format === 'json' ? json() : yaml(),
    indentUnit.of(unit),
    EditorState.tabSize.of(unit === '\t' ? 4 : unit.length),
    EditorState.lineSeparator.of(content.includes('\r\n') ? '\r\n' : '\n'),
  ];
}
