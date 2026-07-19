import * as YAML from 'yaml';

import { loadConfig } from '../src/config';
import { ActivationConfigInputV1 } from '../src/config/v1';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const testRoot = mkdtempSync(path.join(tmpdir(), 'fraq-cli-config-'));

after(() => {
  process.chdir(originalCwd);
  globalThis.fetch = originalFetch;
  rmSync(testRoot, { recursive: true, force: true });
});

test('rejects unknown fields throughout activation config', () => {
  const invalidConfigs = [
    { defualt: 'mention' },
    { default: { type: 'mention', prefex: '/' } },
    {
      overrides: [
        {
          match: { plugn: 'help' },
          rule: 'mention',
        },
      ],
    },
    {
      overrides: [
        {
          match: { plugin: 'help' },
          rule: 'mention',
          priority: 1,
        },
      ],
    },
  ];

  for (const config of invalidConfigs) {
    assert.equal(ActivationConfigInputV1.safeParse(config).success, false, JSON.stringify(config));
  }
});

test('continues to normalize valid activation shorthands', () => {
  assert.deepEqual(ActivationConfigInputV1.parse('mention'), {
    default: [{ type: 'mention' }],
  });
  assert.deepEqual(
    ActivationConfigInputV1.parse({
      default: { type: 'prefix', prefix: '/' },
      overrides: [
        {
          match: { plugin: 'help', tag: ['public', 'utility'] },
          rule: ['direct', { type: 'mention', prefix: '/' }],
        },
      ],
    }),
    {
      default: [{ type: 'prefix', prefix: '/' }],
      overrides: [
        {
          match: { plugin: ['help'], tag: ['public', 'utility'] },
          rule: [{ type: 'direct' }, { type: 'mention', prefix: '/' }],
        },
      ],
    },
  );
});

test('fills, merges, prunes, and persists plugin versions without rewriting fraq.yml', async () => {
  const fraqConfig = {
    configVersion: 1 as const,
    fraqVersion: '0.13.0',
    milky: {
      url: 'http://localhost:3000',
    },
    logging: {
      minLevel: 'info' as const,
    },
    versions: {
      pinned: '2.0.0',
    } as Record<string, string>,
    plugins: {
      auto: {},
      pinned: {},
    },
    forks: {
      child: {
        plugins: {
          'scope/child': {},
        },
      },
    },
  };
  const fraqContent = YAML.stringify(fraqConfig);
  writeFileSync(path.join(testRoot, 'fraq.yml'), fraqContent);

  const fetchedPackages: string[] = [];
  const latestVersions: Record<string, string> = {
    'fraq-plugin-auto': '1.2.3',
    '@scope/fraq-plugin-child': '4.5.6',
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    const packageName = url.slice('https://registry.npmjs.org/'.length, -'/latest'.length);
    fetchedPackages.push(packageName);
    const version = latestVersions[packageName];
    return new Response(JSON.stringify({ name: packageName, version }), {
      status: version ? 200 : 404,
      statusText: version ? 'OK' : 'Not Found',
      headers: {
        'content-type': 'application/json',
      },
    });
  };

  process.chdir(testRoot);
  try {
    const config = await loadConfig();

    assert.deepEqual(fetchedPackages, ['fraq-plugin-auto', '@scope/fraq-plugin-child']);
    assert.deepEqual(config.versions, {
      auto: '1.2.3',
      pinned: '2.0.0',
      'scope/child': '4.5.6',
    });
    assert.deepEqual(Object.keys(config.versions), ['auto', 'pinned', 'scope/child']);
    assert.equal(readFileSync(path.join(testRoot, 'fraq.yml'), 'utf-8'), fraqContent);
    assert.deepEqual(YAML.parse(readFileSync(path.join(testRoot, 'versions.yml'), 'utf-8')), config.versions);

    fraqConfig.fraqVersion = '0.14.0';
    fraqConfig.versions.auto = '9.0.0';
    writeFileSync(path.join(testRoot, 'fraq.yml'), YAML.stringify(fraqConfig));
    fetchedPackages.length = 0;

    const overriddenConfig = await loadConfig();

    assert.deepEqual(fetchedPackages, []);
    assert.deepEqual(overriddenConfig.versions, {
      auto: '9.0.0',
      pinned: '2.0.0',
      'scope/child': '4.5.6',
    });
    assert.deepEqual(YAML.parse(readFileSync(path.join(testRoot, 'versions.yml'), 'utf-8')), overriddenConfig.versions);

    delete (fraqConfig.plugins as Record<string, object>).pinned;
    delete (fraqConfig.forks as Record<string, object>).child;
    writeFileSync(path.join(testRoot, 'fraq.yml'), YAML.stringify(fraqConfig));
    fetchedPackages.length = 0;

    const prunedConfig = await loadConfig();

    assert.deepEqual(fetchedPackages, []);
    assert.deepEqual(prunedConfig.versions, {
      auto: '9.0.0',
    });
    assert.deepEqual(YAML.parse(readFileSync(path.join(testRoot, 'versions.yml'), 'utf-8')), prunedConfig.versions);
  } finally {
    process.chdir(originalCwd);
  }
});
