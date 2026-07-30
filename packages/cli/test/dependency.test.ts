import type { Config } from '../src/config';
import { getPluginDependencyDiagnostic, normalizePluginName } from '../src/dependency';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const originalCwd = process.cwd();
const testRoot = mkdtempSync(path.join(tmpdir(), 'fraq-cli-dependency-'));

after(() => {
  process.chdir(originalCwd);
  rmSync(testRoot, { recursive: true, force: true });
});

function cachePackage(name: string, version: string, peerDependencies?: Record<string, string>): void {
  const packageName = normalizePluginName(name);
  const cacheFile = path.join(testRoot, 'cache', 'package-json', `${packageName}@${version}.json`);
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ name: packageName, version, peerDependencies }));
}

function createConfig(context: Pick<Config, 'plugins' | 'forks'>, pluginVersions: Record<string, string>): Config {
  return {
    configVersion: 1,
    fraqVersion: '0.1.0',
    milky: {
      url: 'http://localhost:3000',
      connectEvent: true,
    },
    logging: {
      minLevel: 'info',
    },
    versions: pluginVersions,
    ...context,
  };
}

async function withTestRoot<T>(run: () => Promise<T>): Promise<T> {
  process.chdir(testRoot);
  try {
    return await run();
  } finally {
    process.chdir(originalCwd);
  }
}

test('accepts plugin dependencies from the same context and parent contexts', async () => {
  cachePackage('consumer', '1.0.0', {
    [normalizePluginName('provider')]: '^2.0.0',
    react: '^19.0.0',
  });
  cachePackage('provider', '2.0.0');
  cachePackage('scope/child-consumer', '1.0.0', {
    [normalizePluginName('provider')]: '*',
  });

  const diagnostic = await withTestRoot(() =>
    getPluginDependencyDiagnostic(
      createConfig(
        {
          plugins: {
            consumer: {},
            provider: {},
          },
          forks: {
            child: {
              plugins: {
                'scope/child-consumer': {},
              },
            },
          },
        },
        {
          consumer: '1.0.0',
          provider: '2.0.0',
          'scope/child-consumer': '1.0.0',
        },
      ),
    ),
  );

  assert.deepEqual(diagnostic, { status: 'ok' });
});

test('reports every plugin dependency unavailable from its context parent chain', async () => {
  cachePackage('root-consumer', '1.0.0', {
    [normalizePluginName('child-provider')]: '*',
  });
  cachePackage('alpha-consumer', '1.0.0', {
    [normalizePluginName('root-provider')]: '*',
    [normalizePluginName('beta-provider')]: '*',
    [normalizePluginName('missing-alpha')]: '*',
    zod: '^4.0.0',
  });
  cachePackage('root-provider', '1.0.0');
  cachePackage('child-provider', '1.0.0');
  cachePackage('nested-consumer', '1.0.0', {
    [normalizePluginName('child-provider')]: '*',
  });
  cachePackage('beta-provider', '1.0.0');
  cachePackage('beta-consumer', '1.0.0', {
    [normalizePluginName('missing-beta')]: '*',
  });

  const diagnostic = await withTestRoot(() =>
    getPluginDependencyDiagnostic(
      createConfig(
        {
          plugins: {
            'root-consumer': {},
            'root-provider': {},
          },
          forks: {
            alpha: {
              plugins: {
                'alpha-consumer': {},
                'child-provider': {},
              },
              forks: {
                nested: {
                  plugins: {
                    'nested-consumer': {},
                  },
                },
              },
            },
            beta: {
              plugins: {
                'beta-provider': {},
                'beta-consumer': {},
              },
            },
          },
        },
        {
          'root-consumer': '1.0.0',
          'root-provider': '1.0.0',
          'alpha-consumer': '1.0.0',
          'child-provider': '1.0.0',
          'nested-consumer': '1.0.0',
          'beta-provider': '1.0.0',
          'beta-consumer': '1.0.0',
        },
      ),
    ),
  );

  assert.deepEqual(diagnostic, {
    status: 'missing',
    message: [
      'Plugin "root-consumer" in context "root" requires plugin "child-provider", but it is not installed in that context or any parent context.',
      'Plugin "alpha-consumer" in context "alpha" requires plugin "beta-provider", but it is not installed in that context or any parent context.',
      'Plugin "alpha-consumer" in context "alpha" requires plugin "missing-alpha", but it is not installed in that context or any parent context.',
      'Plugin "beta-consumer" in context "beta" requires plugin "missing-beta", but it is not installed in that context or any parent context.',
    ],
  });
});

test('throws when a plugin version is missing', async () => {
  await assert.rejects(
    withTestRoot(() =>
      getPluginDependencyDiagnostic(
        createConfig(
          {
            plugins: {
              unversioned: {},
            },
          },
          {},
        ),
      ),
    ),
    /Plugin "unversioned" in context "root" has no version declared in config\.versions\./,
  );
});
