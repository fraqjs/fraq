import { history, insertNewlineAndIndent } from '@codemirror/commands';
import { ensureSyntaxTree, indentUnit } from '@codemirror/language';
import { EditorState, type Transaction } from '@codemirror/state';
import { type EditorView, keymap } from '@codemirror/view';
import type { ConfigFile } from '@fraqjs/cli-protocol';

import { configurationKeymap } from '../webui/src/configuration-keymap';
import { configurationLanguage } from '../webui/src/configuration-language';

import assert from 'node:assert/strict';
import test from 'node:test';

function createEditor(content: string, format: ConfigFile['format'] = 'yaml') {
  const target = {
    state: EditorState.create({
      doc: content,
      selection: { anchor: content.replaceAll('\r\n', '\n').length },
      extensions: [configurationLanguage(format, content), history(), keymap.of(configurationKeymap)],
    }),
    dispatch(transaction: Transaction) {
      target.state = transaction.state;
    },
  };
  return target;
}

test('configured editor keys indent and undo without rewriting YAML comments or references', () => {
  const content = '# original comment\nplugins:\n    example:\n        token: ${{ env:TOKEN }}';
  const editor = createEditor(content);
  const bindings = editor.state.facet(keymap).flat();
  const tab = bindings.find((binding) => binding.key === 'Tab');
  const undo = bindings.find((binding) => binding.key === 'Mod-z');
  assert.ok(tab?.run && tab.shift && undo?.run);
  assert.equal(insertNewlineAndIndent(editor), true);
  assert.equal(editor.state.sliceDoc(), `${content}\n        `);
  const view = editor as unknown as EditorView;
  assert.equal(tab.run(view), true);
  assert.equal(editor.state.sliceDoc(), `${content}\n            `);
  assert.equal(tab.shift(view), true);
  assert.equal(editor.state.sliceDoc(), `${content}\n        `);
  assert.equal(undo.run(view), true);
  assert.equal(editor.state.sliceDoc(), `${content}\n            `);
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

test('selects YAML comment behavior and a working JSON parser', () => {
  const yaml = createEditor('# comment\nenabled: true');
  const json = createEditor('{"enabled": true}', 'json');
  assert.ok(yaml.state.languageDataAt<{ line?: string }>('commentTokens', 0).some((tokens) => tokens.line === '#'));
  for (const editor of [yaml, json]) {
    const tree = ensureSyntaxTree(editor.state, editor.state.doc.length);
    assert.ok(tree);
    assert.equal(tree.length, editor.state.doc.length);
  }
  const invalidJson = createEditor('{"enabled": }', 'json');
  const tree = ensureSyntaxTree(invalidJson.state, invalidJson.state.doc.length);
  assert.ok(tree);
  let errors = 0;
  tree.iterate({
    enter(node) {
      if (node.type.isError) errors++;
    },
  });
  assert.ok(errors > 0, 'the configured JSON parser must identify malformed syntax');
});

test('keeps text references as plain text with their whitespace and literal expressions', () => {
  const text = '\ufeff  literal ${{ env:NOT_EXPANDED }}\r\n';
  const editor = createEditor(text, 'text');
  assert.equal(editor.state.sliceDoc(), text);
  assert.equal(ensureSyntaxTree(editor.state, editor.state.doc.length), null);
});
