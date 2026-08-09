import { generateAppPackageJson } from '../src/app/package-json';
import { buildStartScript } from '../src/app/start-script';
import type { Config } from '../src/config';
import { ConfigV1 } from '../src/config/v1';
import { getPluginDependencyDiagnostic, normalizePluginName } from '../src/dependency';
import { checkVersionsCompleteness, completeAndSyncVersions } from '../src/versions';
import { getWorkspacePluginEntryPoint } from '../src/workspace-plugins';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const originalCwd = process.cwd();
const testRoot = mkdtempSync(path.join(tmpdir(), 'fraq-cli-workspace-plugins-'));

after(() => {
  process.chdir(originalCwd);
  rmSync(testRoot, { recursive: true, force: true });
});

function createConfig(options: Partial<Config> = {}): Config {
  return {
    configVersion: 1,
    fraqVersion: '1.0.0',
    milky: {
      url: 'http://localhost:3000',
      connectEvent: true,
    },
    logging: {
      minLevel: 'info',
    },
    versions: {},
    ...options,
  };
}

function createFixture(): string {
  const fixturePath = mkdtempSync(path.join(testRoot, 'fixture-'));
  writeFileSync(path.join(fixturePath, 'fraq.yml'), '{}\n');
  return fixturePath;
}

function writePluginPackage(fixturePath: string, directory: string, packageJson: Record<string, unknown>): string {
  const pluginPath = path.join(fixturePath, directory);
  mkdirSync(pluginPath, { recursive: true });
  writeFileSync(path.join(pluginPath, 'package.json'), JSON.stringify(packageJson));
  return pluginPath;
}

test('accepts workspace plugin paths in the configuration schema', () => {
  const result = ConfigV1.safeParse({
    configVersion: 1,
    fraqVersion: '1.0.0',
    milky: { url: 'http://localhost:3000' },
    workspacePlugins: {
      local: ' ../plugin-local ',
    },
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.workspacePlugins, { local: '../plugin-local' });
  }
});

test('installs workspace plugins from local paths instead of npm versions', () => {
  const fixturePath = createFixture();
  process.chdir(fixturePath);

  const packageJson = generateAppPackageJson(
    createConfig({
      versions: {
        local: '9.9.9',
        remote: '1.2.3',
      },
      workspacePlugins: {
        local: 'plugins/local',
      },
    }),
  );

  assert.equal(packageJson.dependencies[normalizePluginName('local')], 'file:../plugins/local');
  assert.equal(packageJson.dependencies[normalizePluginName('remote')], '1.2.3');
});

test('excludes workspace plugins from version completion and lock output', async () => {
  const config = createConfig({
    plugins: {
      local: {},
      remote: {},
    },
    workspacePlugins: {
      local: '../plugin-local',
    },
  });

  assert.deepEqual(checkVersionsCompleteness(config, {}), {
    status: 'missing',
    missingPlugins: ['remote'],
  });
  assert.deepEqual(await completeAndSyncVersions(config, { local: '9.9.9', remote: '1.2.3' }), {
    remote: '1.2.3',
  });
});

test('reads workspace package metadata for plugin dependency diagnostics', async () => {
  const fixturePath = createFixture();
  process.chdir(fixturePath);
  writePluginPackage(fixturePath, 'plugins/consumer', {
    name: normalizePluginName('consumer'),
    peerDependencies: {
      [normalizePluginName('provider')]: 'workspace:^',
    },
  });
  const providerPackageName = normalizePluginName('provider');
  const providerCachePath = path.join(fixturePath, 'cache', 'package-json');
  mkdirSync(providerCachePath, { recursive: true });
  writeFileSync(
    path.join(providerCachePath, `${providerPackageName}@1.0.0.json`),
    JSON.stringify({ name: providerPackageName, version: '1.0.0' }),
  );

  const accessedFiles = new Set<string>();
  const diagnostic = await getPluginDependencyDiagnostic(
    createConfig({
      plugins: {
        consumer: {},
        provider: {},
      },
      versions: {
        provider: '1.0.0',
      },
      workspacePlugins: {
        consumer: 'plugins/consumer',
      },
    }),
    {
      onFileAccess: (filePath) => accessedFiles.add(filePath),
    },
  );

  assert.deepEqual(diagnostic, { status: 'ok' });
  assert.deepEqual(accessedFiles, new Set([path.resolve('plugins/consumer/package.json')]));
});

test('resolves the effective published entry point for watch mode', () => {
  const fixturePath = createFixture();
  process.chdir(fixturePath);
  writePluginPackage(fixturePath, 'plugins/local', {
    name: normalizePluginName('local'),
    main: 'src/index.ts',
    publishConfig: {
      main: 'dist/index.mjs',
    },
  });

  const config = createConfig({
    plugins: { local: {} },
    workspacePlugins: { local: 'plugins/local' },
  });
  assert.equal(
    getWorkspacePluginEntryPoint(config, 'local', normalizePluginName('local')),
    path.resolve('plugins/local/dist/index.mjs'),
  );
  assert.match(buildStartScript(config), /await import\("\.\/node_modules\/fraq-plugin-local\/dist\/index\.mjs"\)/);
});

test('rejects a workspace package whose name does not match the plugin name', async () => {
  const fixturePath = createFixture();
  process.chdir(fixturePath);
  writePluginPackage(fixturePath, 'plugins/local', {
    name: 'unexpected-package-name',
  });

  await assert.rejects(
    getPluginDependencyDiagnostic(
      createConfig({
        plugins: { local: {} },
        workspacePlugins: { local: 'plugins/local' },
      }),
    ),
    /Workspace plugin "local" must use package name "fraq-plugin-local"/,
  );
});
