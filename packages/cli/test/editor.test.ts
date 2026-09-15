import { ControlError } from '@fraqjs/cli-protocol';

import { ConfigEditor } from '../src/config/editor';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const original =
  '# keep this comment\nconfigVersion: 1\nfraqVersion: 1.0.0\nmilky:\n  url: http://localhost:3000\n  accessToken: ${{ text:token.txt }}\n';

test('preserves raw configuration, validates references before writing and rejects stale revisions', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fraq-editor-'));
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync('fraq.yml', original);
  writeFileSync('token.txt', 'SECRET');
  const editor = new ConfigEditor();
  const document = editor.read();
  assert.equal(document.content, original);
  assert.equal(document.content.includes('SECRET'), false);
  const next = original.replace('3000', '4000');
  const saved = editor.save(next, document.revision);
  assert.equal(readFileSync('fraq.yml', 'utf8'), next);
  assert.notEqual(saved.revision, document.revision);
  assert.throws(
    () => editor.save(original, document.revision),
    (error: unknown) => error instanceof ControlError && error.code === 'conflict',
  );
  for (const invalid of [
    '[broken YAML',
    next.replace('configVersion: 1', 'configVersion: 99'),
    next.replace('token.txt', 'missing.txt'),
    next.replace('token.txt', 'fraq.yml').replace('text:', 'tree:'),
  ]) {
    assert.throws(
      () => editor.save(invalid, saved.revision),
      (error: unknown) => error instanceof ControlError && error.code === 'invalid',
    );
    assert.equal(readFileSync('fraq.yml', 'utf8'), next);
  }
  writeFileSync('fraq.yml', `${next}\n# external edit`);
  assert.throws(
    () => editor.save(original, saved.revision),
    (error: unknown) => error instanceof ControlError && error.code === 'conflict',
  );
});

test('validates JSON using its original format', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fraq-json-editor-'));
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
  const content = '{"configVersion":1,"fraqVersion":"1.0.0","milky":{"url":"http://localhost:3000"}}';
  writeFileSync('fraq.json', content);
  const editor = new ConfigEditor();
  assert.throws(() => editor.save(original, editor.read().revision));
  assert.equal(editor.save(`${content}\n`, editor.read().revision).format, 'json');
});
