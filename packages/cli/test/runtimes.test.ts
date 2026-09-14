import { AppLifecycle } from '../src/app/lifecycle';
import { spawnAppProcess } from '../src/app/runner';
import { RuntimeRegistry } from '../src/app/runtimes';
import type { Config } from '../src/config';
import { loadConfig } from '../src/config';
import { getConfigPaths } from '../src/config/shared';

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

const pm = { name: 'npm' as const, commandPath: '/test/npm', installed: true, allCommandPaths: ['/test/npm'] };

function config(url = 'http://localhost:3000'): Config {
  return {
    configVersion: 1,
    fraqVersion: '1.0.0',
    milky: { url, connectEvent: true },
    logging: { minLevel: 'info' },
    versions: {},
  };
}

function workspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fraq-runtimes-')));
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  return root;
}

test('keeps immutable startup scripts and isolated dependencies only for the watch session', async (t) => {
  const root = workspace(t);
  const directories: string[] = [];
  let installResult = 0;
  const registry = new RuntimeRegistry(path.join(root, 'app'), async (_pm, directory = '') => {
    directories.push(directory);
    writeFileSync(path.join(directory, 'dependency-marker'), 'installed');
    return installResult;
  });
  const options = { refresh: false };
  const first = await registry.prepare(config(), pm, options);
  const second = await registry.prepare(config('http://localhost:4000'), pm, options);
  assert.equal(first.directory, second.directory);
  assert.notEqual(first.entryPoint, second.entryPoint);
  assert.equal(readFileSync(first.entryPoint, 'utf8'), first.startScript);
  assert.equal(directories.length, 1);

  installResult = 1;
  await assert.rejects(registry.prepare({ ...config(), fraqVersion: '2.0.0' }, pm, options), /install failed/);
  assert.notEqual(directories[0], directories[1]);
  const failedDirectory = directories[1];
  assert.ok(failedDirectory);
  assert.equal(existsSync(failedDirectory), false);
  assert.equal(readFileSync(path.join(first.directory, 'dependency-marker'), 'utf8'), 'installed');
  if (process.platform !== 'win32') {
    assert.equal(statSync(first.entryPoint).mode & 0o777, 0o600);
  }
  registry.close();
  assert.equal(existsSync(first.directory), false);
  assert.equal(existsSync(path.join(root, 'app', 'last-success.json')), false);
});

test('rebases local plugin dependencies for isolated runtime directories', async (t) => {
  const root = workspace(t);
  writeFileSync('fraq.yml', 'configVersion: 1');
  mkdirSync('plugin');
  writeFileSync('plugin/package.json', JSON.stringify({ name: 'fraq-plugin-local', main: 'index.mjs' }));
  let manifest: { dependencies: Record<string, string> } | undefined;
  const registry = new RuntimeRegistry(path.join(root, 'app'), async (_pm, directory = '') => {
    manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    return 0;
  });
  const result = await registry.prepare(
    {
      ...config(),
      plugins: { local: {} },
      workspacePlugins: { local: './plugin' },
      additionalDependencies: { extra: 'file:../extra' },
    },
    pm,
    { refresh: false },
  );
  const dependency = manifest?.dependencies['fraq-plugin-local'];
  assert.ok(dependency);
  assert.equal(path.resolve(result.directory, dependency.slice(5)), path.join(root, 'plugin'));
  assert.equal(manifest?.dependencies.extra, `file:${path.join(root, 'extra')}`);
});

test('real watch reload restores the resolved configuration but a new session cannot recover', async (t) => {
  const root = workspace(t);
  const appPath = path.join(root, 'app');
  const registry = new RuntimeRegistry(appPath, async (_pm, directory = '') => {
    for (const [name, source] of [
      [
        '@fraqjs/fraq',
        `
        export const filter = {};
        export const Context = {
          fromUrl(url) {
            let timer;
            return {
              logger: { info() {}, error() {} },
              async start() {
                if (url.includes('4000')) throw new Error('candidate startup failed');
                timer = setInterval(() => {}, 1000);
              },
              async stop() { clearInterval(timer); }
            };
          }
        };
      `,
      ],
      ['@fraqjs/color-log', 'export const createColoredLogHandler = () => {};'],
    ] as const) {
      const packagePath = path.join(directory, 'node_modules', name);
      mkdirSync(packagePath, { recursive: true });
      writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ type: 'module', main: './index.js' }));
      writeFileSync(path.join(packagePath, 'index.js'), source);
    }
    return 0;
  });
  writeFileSync(
    'fraq.yml',
    `configVersion: 1\nfraqVersion: 1.0.0\nmilky:\n  url: http://localhost:3000\n  accessToken: \${{ text:token.txt }}\n`,
  );
  writeFileSync('token.txt', 'original-token\n');
  const launched: string[] = [];
  const createLifecycle = () =>
    AppLifecycle.create({
      initialFiles: getConfigPaths(),
      async prepare(accessedFiles) {
        return {
          config: await loadConfig({
            resolveAllReferences: true,
            throwOnValidationError: true,
            onFileAccess: (file) => accessedFiles.add(file),
          }),
          packageManager: pm,
        };
      },
      dependencies: {
        createRuntimes: () => registry,
        createSources: () => ({ update() {}, async close() {} }),
        spawn(entry) {
          launched.push(entry ?? '');
          return spawnAppProcess(entry);
        },
      },
    });
  const first = createLifecycle();
  t.after(() => first.shutdown('SIGKILL'));
  await first.start();
  const saved = launched[0];
  assert.ok(saved);
  assert.ok(readFileSync(saved, 'utf8').includes('original-token'));
  assert.equal(existsSync(path.join(appPath, 'last-success.json')), false);

  writeFileSync('fraq.yml', JSON.stringify(config('http://localhost:4000')));
  await first.reconcile();
  assert.equal(launched.length, 3);
  assert.equal(launched[2], saved);
  await first.shutdown();
  assert.equal(existsSync(saved), false);

  writeFileSync('fraq.yml', '[bad YAML');
  rmSync('token.txt');
  const restored = createLifecycle();
  t.after(() => restored.shutdown('SIGKILL'));
  await restored.start();
  assert.equal(await restored.waitForExit(), 1);
  assert.equal(launched.length, 3);
  assert.equal(readFileSync('fraq.yml', 'utf8'), '[bad YAML');
  await restored.shutdown();
});
