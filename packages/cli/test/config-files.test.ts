import { type ConfigWorkspace, ControlError, MAX_CONFIG_BYTES } from '@fraqjs/cli-protocol';

import { ConfigEditor } from '../src/config/editor';

import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

function fixture(t: TestContext, main: string) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fraq-config-files-')));
  mkdirSync(path.join(root, 'project'));
  mkdirSync(path.join(root, 'project-other'));
  const previous = process.cwd();
  process.chdir(path.join(root, 'project'));
  writeFileSync('fraq.yml', main);
  t.after(() => {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const header = 'configVersion: 1\nfraqVersion: 1.0.0\n';
const code = (expected: string) => (error: unknown) => error instanceof ControlError && error.code === expected;
function change(workspace: ConfigWorkspace, name: string, content: string) {
  const file = workspace.files.find((file) => file.name === name);
  assert.ok(file, `Missing ${name}`);
  return { id: file.id, content };
}

test('discovers nested references, deduplicates symlinks and withholds every outside file body', (t) => {
  fixture(
    t,
    `${header}milky: \${{ tree:sub/milky.yml }}\nplugins:\n  example:\n    secret: \${{ text:../project-other/private.txt }}\n    alias: \${{ text:alias.txt }}\n`,
  );
  mkdirSync('sub');
  writeFileSync('sub/milky.yml', 'url: http://localhost:3000\naccessToken: ${{ text:../token.txt }}\n');
  writeFileSync('token.txt', '\ufeffLOCAL\r\n');
  writeFileSync('../project-other/private.txt', 'OUTSIDE_SECRET');
  writeFileSync('unreferenced.txt', 'UNREFERENCED');
  symlinkSync('token.txt', 'alias.txt');
  const editor = new ConfigEditor();
  const workspace = editor.list();
  assert.equal(workspace.error, undefined);
  assert.deepEqual(
    workspace.files.map((file) => file.name),
    ['fraq.yml', 'sub/milky.yml', 'token.txt', '../project-other/private.txt'],
  );
  const outside = workspace.files.find((file) => !file.editable);
  assert.ok(outside && !outside.editable);
  assert.equal(outside.reason, '超出编辑范围');
  assert.equal('content' in outside, false);
  assert.equal(JSON.stringify(workspace).includes('OUTSIDE_SECRET'), false);
  const token = workspace.files.find((file) => file.name === 'token.txt');
  assert.ok(token?.editable);
  assert.equal(token.format, 'text');
  assert.equal(token.content, '\ufeffLOCAL\r\n');
  assert.throws(
    () => editor.saveFiles({ revision: workspace.revision, files: [{ id: outside.id, content: 'overwrite' }] }),
    code('invalid'),
  );
  assert.throws(
    () =>
      editor.saveFiles({
        revision: workspace.revision,
        files: [{ id: '../project-other/private.txt', content: 'overwrite' }],
      }),
    code('invalid'),
  );
  assert.equal(readFileSync('../project-other/private.txt', 'utf8'), 'OUTSIDE_SECRET');
});

test('validates all drafts together and preserves file text and permissions', (t) => {
  const main = `${header}milky: \${{ tree:milky.yml }}\n`;
  fixture(t, main);
  const reference = '# original\nurl: http://localhost:3000\n';
  writeFileSync('milky.yml', reference);
  chmodSync('milky.yml', 0o660);
  const editor = new ConfigEditor();
  const workspace = editor.list();
  const nextMain = `${header}milky:\n  url: \${{ tree:milky.yml }}\n`;
  const nextReference = '# retained comment\n"http://localhost:4000"\n';
  const changes = [change(workspace, 'fraq.yml', nextMain), change(workspace, 'milky.yml', nextReference)];
  for (const single of changes) {
    assert.throws(() => editor.saveFiles({ revision: workspace.revision, files: [single] }), code('invalid'));
    assert.equal(readFileSync('fraq.yml', 'utf8'), main);
    assert.equal(readFileSync('milky.yml', 'utf8'), reference);
  }
  const saved = editor.saveFiles({ revision: workspace.revision, files: changes });
  assert.equal(saved.error, undefined);
  assert.equal(readFileSync('fraq.yml', 'utf8'), nextMain);
  assert.equal(readFileSync('milky.yml', 'utf8'), nextReference);
  assert.equal(statSync('milky.yml').mode & 0o777, 0o660);
  assert.deepEqual(readdirSync('.').sort(), ['fraq.yml', 'milky.yml']);
});

test('rejects changes when an unedited dependency or a symlink target changed', (t) => {
  fixture(t, `${header}milky:\n  url: http://localhost:3000\n  accessToken: \${{ text:alias.txt }}\n`);
  writeFileSync('token.txt', 'first');
  writeFileSync('../project-other/token.txt', 'outside');
  symlinkSync('token.txt', 'alias.txt');
  const editor = new ConfigEditor();
  const workspace = editor.list();
  const changes = [change(workspace, 'fraq.yml', `${header}milky:\n  url: http://localhost:4000\n`)];
  writeFileSync('token.txt', 'external');
  assert.throws(() => editor.saveFiles({ revision: workspace.revision, files: changes }), code('conflict'));
  const beforeLink = editor.list();
  unlinkSync('alias.txt');
  symlinkSync('../project-other/token.txt', 'alias.txt');
  assert.throws(() => editor.saveFiles({ revision: beforeLink.revision, files: changes }), code('conflict'));
  const outside = editor.list().files.find((file) => file.name.startsWith('../'));
  assert.ok(outside && !outside.editable);
  assert.equal('content' in outside, false);
});

test('keeps broken and missing references visible and continues discovering sibling references', (t) => {
  fixture(
    t,
    `${header}milky: \${{ tree:broken.yml }}\nplugins:\n  example:\n    text: \${{ text:missing.txt }} \${{ text:valid.txt }}\n`,
  );
  writeFileSync('broken.yml', '[invalid YAML');
  writeFileSync('valid.txt', 'value');
  const editor = new ConfigEditor();
  const workspace = editor.list();
  assert.ok(workspace.error);
  assert.deepEqual(
    workspace.files.map((file) => file.name),
    ['fraq.yml', 'broken.yml', 'missing.txt', 'valid.txt'],
  );
  assert.equal(workspace.files.find((file) => file.name === 'broken.yml')?.editable, true);
  assert.equal(workspace.files.find((file) => file.name === 'missing.txt')?.editable, false);
  const saved = editor.saveFiles({
    revision: workspace.revision,
    files: [
      change(workspace, 'fraq.yml', `${header}milky: \${{ tree:broken.yml }}\n`),
      change(workspace, 'broken.yml', 'url: http://localhost:3000\n'),
    ],
  });
  assert.equal(saved.error, undefined);
  assert.deepEqual(
    saved.files.map((file) => file.name),
    ['fraq.yml', 'broken.yml'],
  );
});

test('uses the real main configuration directory as the boundary and preserves its symlink', (t) => {
  const root = fixture(t, `${header}milky:\n  url: http://localhost:3000\n`);
  mkdirSync('../launcher');
  const actual = path.join(root, 'project', 'fraq.yml');
  writeFileSync(
    actual,
    `${header}milky:\n  url: http://localhost:3000\n  accessToken: \${{ text:${path.join(root, 'project', 'token.txt')} }}\n`,
  );
  writeFileSync('token.txt', 'local');
  symlinkSync('../project/fraq.yml', '../launcher/fraq.yml');
  process.chdir('../launcher');
  const editor = new ConfigEditor();
  const workspace = editor.list();
  assert.equal(workspace.root, path.join(root, 'project'));
  assert.ok(workspace.files.every((file) => file.editable));
  editor.saveFiles({ revision: workspace.revision, files: [change(workspace, 'token.txt', 'updated')] });
  assert.equal(realpathSync('fraq.yml'), actual);
  assert.equal(readFileSync('../project/token.txt', 'utf8'), 'updated');
});

test('marks binary, non-UTF8 and oversized references read-only', (t) => {
  fixture(
    t,
    `${header}milky:\n  url: http://localhost:3000\nplugins:\n  example:\n    a: \${{ text:binary }}\n    b: \${{ text:encoding }}\n    c: \${{ text:large }}\n`,
  );
  writeFileSync('binary', Buffer.from([0, 1, 2]));
  writeFileSync('encoding', Buffer.from([0xff]));
  writeFileSync('large', Buffer.alloc(MAX_CONFIG_BYTES + 1, 65));
  const workspace = new ConfigEditor().list();
  for (const file of workspace.files.filter((file) => !file.main)) {
    assert.equal(file.editable, false);
    assert.equal('content' in file, false);
  }
});

test('restores earlier replacements if a later file cannot be replaced', (t) => {
  const main = `${header}milky: \${{ tree:milky.yml }}\n`;
  fixture(t, main);
  const reference = 'url: http://localhost:3000\n';
  writeFileSync('milky.yml', reference);
  let replacements = 0;
  const editor = new ConfigEditor((from, to) => {
    if (++replacements === 2) throw new Error('simulated rename failure');
    renameSync(from, to);
  });
  const workspace = editor.list();
  assert.throws(
    () =>
      editor.saveFiles({
        revision: workspace.revision,
        files: [
          change(workspace, 'fraq.yml', `# new comment\n${main}`),
          change(workspace, 'milky.yml', reference.replace('3000', '4000')),
        ],
      }),
    code('internal'),
  );
  assert.equal(readFileSync('fraq.yml', 'utf8'), main);
  assert.equal(readFileSync('milky.yml', 'utf8'), reference);
  assert.deepEqual(readdirSync('.').sort(), ['fraq.yml', 'milky.yml']);
});

test('does not disclose outside file excerpts in validation errors', (t) => {
  fixture(t, `${header}milky: \${{ tree:../project-other/private.yml }}\n`);
  writeFileSync('../project-other/private.yml', '{ PRIVATE_SECRET: [');
  const editor = new ConfigEditor();
  const workspace = editor.list();
  assert.equal(JSON.stringify(workspace).includes('PRIVATE_SECRET'), false);
  assert.throws(
    () =>
      editor.saveFiles({
        revision: workspace.revision,
        files: [
          change(workspace, 'fraq.yml', `# changed\n${header}milky: \${{ tree:../project-other/private.yml }}\n`),
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ControlError);
      assert.equal(error.message.includes('PRIVATE_SECRET'), false);
      return error.code === 'invalid';
    },
  );
});

test('rejects oversized combined drafts and binary replacements before writing', (t) => {
  const references = Array.from({ length: 4 }, (_, index) => `    file${index}: \${{ text:file${index}.txt }}\n`).join(
    '',
  );
  fixture(t, `${header}milky:\n  url: http://localhost:3000\nplugins:\n  example:\n${references}`);
  for (let index = 0; index < 4; index++) writeFileSync(`file${index}.txt`, 'original');
  const editor = new ConfigEditor();
  const workspace = editor.list();
  assert.throws(
    () => editor.saveFiles({ revision: workspace.revision, files: [change(workspace, 'file0.txt', '\0binary')] }),
    code('invalid'),
  );
  assert.throws(
    () =>
      editor.saveFiles({
        revision: workspace.revision,
        files: Array.from({ length: 4 }, (_, index) =>
          change(workspace, `file${index}.txt`, 'a'.repeat(MAX_CONFIG_BYTES)),
        ),
      }),
    code('invalid'),
  );
  for (let index = 0; index < 4; index++) assert.equal(readFileSync(`file${index}.txt`, 'utf8'), 'original');
});
