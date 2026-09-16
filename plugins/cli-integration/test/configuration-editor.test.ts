import { history, indentLess, indentMore, insertNewlineAndIndent, undo } from '@codemirror/commands';
import { ensureSyntaxTree, indentUnit } from '@codemirror/language';
import { EditorState, type Transaction } from '@codemirror/state';
import type { ConfigDocument } from '@fraqjs/cli-protocol';

import { configurationLanguage } from '../webui/src/configuration-language';

import assert from 'node:assert/strict';
import test from 'node:test';

function createEditor(content: string, format: ConfigDocument['format'] = 'yaml') {
  const target = {
    state: EditorState.create({
      doc: content,
      selection: { anchor: content.replaceAll('\r\n', '\n').length },
      extensions: [configurationLanguage(format, content), history()],
    }),
    dispatch(transaction: Transaction) {
      target.state = transaction.state;
    },
  };
  return target;
}

test('continues YAML indentation and supports Tab, Shift-Tab and undo without rewriting comments or references', () => {
  const content = '# original comment\nplugins:\n    example:\n        token: ${{ env:TOKEN }}';
  const editor = createEditor(content);
  assert.equal(editor.state.facet(indentUnit), '    ');
  assert.equal(insertNewlineAndIndent(editor), true);
  assert.equal(editor.state.sliceDoc(), `${content}\n        `);
  assert.equal(indentMore(editor), true);
  assert.equal(editor.state.sliceDoc(), `${content}\n            `);
  assert.equal(indentLess(editor), true);
  assert.equal(editor.state.sliceDoc(), `${content}\n        `);
  assert.equal(undo(editor), true);
  assert.equal(editor.state.sliceDoc(), `${content}\n            `);
  assert.equal(undo(editor), true);
  assert.equal(editor.state.sliceDoc(), `${content}\n        `);
  assert.equal(undo(editor), true);
  assert.equal(editor.state.sliceDoc(), content);
});

test('indents new JSON blocks while preserving CRLF and the existing indentation width', () => {
  const content = '{\r\n    "plugins": {';
  const editor = createEditor(content, 'json');
  assert.equal(editor.state.sliceDoc(), content);
  assert.equal(insertNewlineAndIndent(editor), true);
  assert.equal(editor.state.sliceDoc(), `${content}\r\n        `);
});

test('uses two spaces for a new configuration and preserves existing tab indentation', () => {
  assert.equal(createEditor('').state.facet(indentUnit), '  ');
  const content = '{\n\t"enabled": true,';
  const editor = createEditor(content, 'json');
  assert.equal(editor.state.facet(indentUnit), '\t');
  insertNewlineAndIndent(editor);
  assert.equal(editor.state.sliceDoc(), `${content}\n\t`);
});

test('selects the YAML or JSON parser for syntax highlighting', () => {
  const yaml = createEditor('# comment\nenabled: true');
  const json = createEditor('{"enabled": true}', 'json');
  assert.equal(ensureSyntaxTree(yaml.state, yaml.state.doc.length)?.topNode.name, 'Stream');
  assert.equal(ensureSyntaxTree(json.state, json.state.doc.length)?.topNode.name, 'JsonText');
});
