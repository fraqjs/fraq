import { prepareApp } from '../src/app';
import { loadProjectConfig } from '../src/config';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('normal and watch startup share validation while only watch tracks workspace entry points', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fraq-configuration-')));
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync('plugin');
  writeFileSync('plugin/package.json', JSON.stringify({ name: 'fraq-plugin-local', main: 'index.mjs' }));
  writeFileSync('plugin/index.mjs', 'export default {};');
  const config = {
    configVersion: 1,
    fraqVersion: '1.0.0',
    packageManager: 'npm',
    milky: { url: 'http://localhost:3000' },
    plugins: { local: {} },
    workspacePlugins: { local: './plugin' },
  };
  writeFileSync('fraq.json', JSON.stringify(config));
  writeFileSync('versions.yml', '{}\n');
  const normalFiles = new Set<string>();
  const watchedFiles = new Set<string>();
  const normal = await prepareApp({ frozenLockfile: true }, normalFiles);
  const watched = await prepareApp({ watch: true }, watchedFiles);
  assert.deepEqual(normal.config, watched.config);
  assert.equal(normal.packageManager.name, 'npm');
  assert.deepEqual([...(normal.restartFiles ?? [])], []);
  assert.deepEqual([...(watched.restartFiles ?? [])], [path.join(root, 'plugin/index.mjs')]);
  assert.ok(normalFiles.has(path.join(root, 'plugin/package.json')));
  assert.ok(watchedFiles.has(path.join(root, 'plugin/index.mjs')));
  assert.equal(readFileSync('versions.yml', 'utf8'), '{}\n');
  writeFileSync('fraq.json', JSON.stringify({ ...config, workspacePlugins: undefined }));
  await assert.rejects(loadProjectConfig({ resolveAllReferences: true }), /plugin versions are missing/);
});
