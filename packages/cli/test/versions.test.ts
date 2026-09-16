import pkg from '../package.json';
import { syncVersions } from '../src/app/configuration';
import { generateAppPackageJson } from '../src/app/package-json';
import { loadProjectConfig } from '../src/config';
import {
  applyVersionUpdates,
  checkOutdatedVersions,
  checkVersionsCompleteness,
  completeAndSyncVersions,
} from '../src/versions';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const testRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'fraq-cli-versions-'));

after(() => {
  process.chdir(originalCwd);
  globalThis.fetch = originalFetch;
  rmSync(testRoot, { recursive: true, force: true });
});

test('checks Fraq and plugin versions together', async () => {
  process.chdir(testRoot);
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    const versions: Record<string, string> = {
      'https://registry.npmjs.org/@fraqjs/fraq/latest': '2.0.0',
      'https://registry.npmjs.org/fraq-plugin-current/latest': '1.0.0',
      'https://registry.npmjs.org/fraq-plugin-old/latest': '1.2.0',
    };
    if (url === 'https://registry.npmjs.org/fraq-plugin-broken/latest') {
      return new Response(null, { status: 503, statusText: 'Service Unavailable' });
    }
    return Response.json({ version: versions[url] });
  };

  const result = await checkOutdatedVersions('1.0.0', {
    current: '1.0.0',
    old: '1.0.0',
    broken: '1.0.0',
    'fraqjs/cli-integration': pkg.version,
  });

  assert.deepEqual(result.outdated, [
    { type: 'fraq', name: 'Fraq', current: '1.0.0', latest: '2.0.0' },
    { type: 'plugin', name: 'old', current: '1.0.0', latest: '1.2.0' },
  ]);
  assert.deepEqual(
    result.errors.map(({ name }) => name),
    ['broken'],
  );
  assert.ok(result.errors[0]?.error instanceof Error);
  assert.deepEqual(requestedUrls.sort(), [
    'https://registry.npmjs.org/@fraqjs/fraq/latest',
    'https://registry.npmjs.org/fraq-plugin-broken/latest',
    'https://registry.npmjs.org/fraq-plugin-current/latest',
    'https://registry.npmjs.org/fraq-plugin-old/latest',
  ]);
});

test('binds CLI integration to the CLI version without querying latest or rewriting the main config', async () => {
  const plugin = 'fraqjs/cli-integration';
  const config = {
    configVersion: 1,
    fraqVersion: '0.14.0',
    milky: { url: 'http://localhost:3000' },
    forks: { management: { plugins: { [plugin]: {} } } },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.fail('CLI integration version resolution must not query the registry');
  };
  try {
    assert.deepEqual(checkVersionsCompleteness(config, {}), { status: 'ok' });
    assert.deepEqual(await completeAndSyncVersions(config, {}), { [plugin]: pkg.version });
    assert.deepEqual(await completeAndSyncVersions(config, { [plugin]: '0.0.1' }), { [plugin]: pkg.version });

    for (const versions of [undefined, { [plugin]: '0.0.2' }]) {
      const fixturePath = mkdtempSync(path.join(testRoot, 'cli-binding-'));
      process.chdir(fixturePath);
      const originalConfig = JSON.stringify({ ...config, versions });
      writeFileSync('fraq.json', originalConfig);
      // Frozen loading also binds versions, including when the lockfile is stale or absent.
      for (const lockfile of ['{}\n', `${plugin}: 0.0.1\n`]) {
        writeFileSync('versions.yml', lockfile);
        const loaded = await loadProjectConfig({ resolveAllReferences: true });
        assert.equal(loaded.versions[plugin], pkg.version);
        assert.equal(generateAppPackageJson(loaded).dependencies['@fraqjs/plugin-cli-integration'], pkg.version);
        assert.equal(readFileSync('versions.yml', 'utf8'), lockfile);
      }
      assert.equal(await syncVersions({ silent: true }), true);
      assert.equal(readFileSync('versions.yml', 'utf8'), `${plugin}: ${pkg.version}\n`);
      assert.equal(await syncVersions({ silent: true }), false);
      assert.equal(readFileSync('fraq.json', 'utf8'), originalConfig);
    }

    const workspaceConfig = { ...config, workspacePlugins: { [plugin]: '../cli-integration' } };
    assert.deepEqual(await completeAndSyncVersions(workspaceConfig, { [plugin]: '0.0.1' }), {});
    writeFileSync('fraq.json', JSON.stringify(workspaceConfig));
    const local = await loadProjectConfig({ resolveAllReferences: true });
    assert.equal(
      generateAppPackageJson(local).dependencies['@fraqjs/plugin-cli-integration'],
      'file:../../cli-integration',
    );

    writeFileSync('fraq.json', JSON.stringify({ ...config, forks: undefined }));
    writeFileSync('versions.yml', '{}\n');
    assert.deepEqual((await loadProjectConfig()).versions, {});
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('updates version scalars without replacing their surrounding YAML nodes', () => {
  const fixturePath = mkdtempSync(path.join(testRoot, 'updates-'));
  process.chdir(fixturePath);
  writeFileSync(
    path.join(fixturePath, 'fraq.yml'),
    [
      '# project config',
      'configVersion: 1',
      'fraqVersion: "0.14.0" # Fraq pin',
      'milky:',
      '  url: http://localhost:3000',
      'versions:',
      "  local: '1.0.0' # config only",
      '  shared: 1.0.0 # config and lockfile',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(fixturePath, 'versions.yml'),
    ['# generated lockfile', 'locked: 1.0.0 # lockfile only', 'shared: "1.0.0" # duplicated', ''].join('\n'),
  );

  const changedFiles = applyVersionUpdates({
    fraqVersion: '0.15.0',
    pluginVersions: {
      local: '1.1.0',
      locked: '2.0.0',
      shared: '1.2.0',
    },
  });

  assert.deepEqual(changedFiles, [path.join(fixturePath, 'fraq.yml'), path.join(fixturePath, 'versions.yml')]);
  assert.equal(
    readFileSync(path.join(fixturePath, 'fraq.yml'), 'utf-8'),
    [
      '# project config',
      'configVersion: 1',
      'fraqVersion: "0.15.0" # Fraq pin',
      'milky:',
      '  url: http://localhost:3000',
      'versions:',
      "  local: '1.1.0' # config only",
      '  shared: 1.2.0 # config and lockfile',
      '',
    ].join('\n'),
  );
  assert.equal(
    readFileSync(path.join(fixturePath, 'versions.yml'), 'utf-8'),
    ['# generated lockfile', 'locked: 2.0.0 # lockfile only', 'shared: "1.2.0" # duplicated', ''].join('\n'),
  );
});

test('does not replace a referenced versions node in the main config', () => {
  const fixturePath = mkdtempSync(path.join(testRoot, 'referenced-updates-'));
  process.chdir(fixturePath);
  const config = [
    'configVersion: 1',
    'fraqVersion: 0.14.0',
    'milky:',
    '  url: http://localhost:3000',
    'versions: ${{ tree:plugin-versions.yml }}',
    '',
  ].join('\n');
  writeFileSync(path.join(fixturePath, 'fraq.yml'), config);
  writeFileSync(path.join(fixturePath, 'versions.yml'), 'example: 1.0.0\n');

  assert.throws(
    () => applyVersionUpdates({ pluginVersions: { example: '2.0.0' } }),
    /Cannot update plugin versions because "versions" .* is declared through a reference/,
  );
  assert.equal(readFileSync(path.join(fixturePath, 'fraq.yml'), 'utf-8'), config);
  assert.equal(readFileSync(path.join(fixturePath, 'versions.yml'), 'utf-8'), 'example: 1.0.0\n');
});
