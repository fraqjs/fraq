import * as YAML from 'yaml';

import { loadConfig } from '../src/config';
import { parseConfigReferences } from '../src/config/references';
import { ActivationConfigInputV1, ConfigV1 } from '../src/config/v1';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const testRoot = mkdtempSync(path.join(tmpdir(), 'fraq-cli-config-'));

function parseResolvedConfigFile(filePath: string): unknown {
  return parseConfigReferences(filePath, true);
}

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

test('resolves environment and text references in configuration strings', () => {
  const fixturePath = mkdtempSync(path.join(testRoot, 'values-'));
  const configPath = path.join(fixturePath, 'fraq.yml');
  const absoluteTextPath = path.join(fixturePath, 'absolute secret.txt');
  const variableName = 'FRAQ_TEST_REFERENCE_HOST';
  const emptyVariableName = 'FRAQ_TEST_REFERENCE_EMPTY';
  const originalVariable = process.env[variableName];
  const originalEmptyVariable = process.env[emptyVariableName];

  writeFileSync(path.join(fixturePath, 'secret.txt'), 'first\nsecond\n\n');
  writeFileSync(absoluteTextPath, 'absolute\r\n');
  writeFileSync(path.join(fixturePath, 'literal.txt'), '${{ env:DO_NOT_READ }}\n');
  writeFileSync(
    configPath,
    YAML.stringify({
      endpoint: `https://\${{ env:${variableName} }}/api`,
      empty: `\${{ env:${emptyVariableName} }}`,
      secret: '${{ text:secret.txt }}',
      absolute: `value=\${{ text:${absoluteTextPath} }}`,
      literalFromText: '${{ text:literal.txt }}',
      escaped: '$${{ env:DO_NOT_READ }}',
      ordinary: 'unchanged',
      '${{ env:FRAQ_TEST_REFERENCE_KEY }}': 'key unchanged',
    }),
  );

  process.env[variableName] = 'localhost:3000';
  process.env[emptyVariableName] = '';
  try {
    assert.deepEqual(parseResolvedConfigFile(configPath), {
      endpoint: 'https://localhost:3000/api',
      empty: '',
      secret: 'first\nsecond\n',
      absolute: 'value=absolute',
      literalFromText: '${{ env:DO_NOT_READ }}',
      escaped: '${{ env:DO_NOT_READ }}',
      ordinary: 'unchanged',
      '${{ env:FRAQ_TEST_REFERENCE_KEY }}': 'key unchanged',
    });
  } finally {
    if (originalVariable === undefined) {
      delete process.env[variableName];
    } else {
      process.env[variableName] = originalVariable;
    }
    if (originalEmptyVariable === undefined) {
      delete process.env[emptyVariableName];
    } else {
      process.env[emptyVariableName] = originalEmptyVariable;
    }
  }
});

test('injects native tree values and resolves nested paths from the containing file', () => {
  const fixturePath = mkdtempSync(path.join(testRoot, 'trees-'));
  const partsPath = path.join(fixturePath, 'parts');
  const configPath = path.join(fixturePath, 'fraq.json');
  const variableName = 'FRAQ_TEST_REFERENCE_LABEL';
  const originalVariable = process.env[variableName];
  mkdirSync(partsPath);

  writeFileSync(path.join(partsPath, 'note.txt'), 'nested note\n');
  writeFileSync(
    path.join(partsPath, 'options.json'),
    JSON.stringify({
      enabled: true,
      count: 2,
      missing: null,
      tags: ['one', 'two'],
      label: `\${{ env:${variableName} }}`,
    }),
  );
  writeFileSync(
    path.join(partsPath, 'plugins.yaml'),
    YAML.stringify({
      primary: {
        options: '${{ tree:options.json }}',
        note: '${{ text:note.txt }}',
      },
    }),
  );
  writeFileSync(path.join(partsPath, 'count.yml'), '42\n');
  writeFileSync(
    configPath,
    JSON.stringify({ plugins: '${{ tree:parts/plugins.yaml }}', count: '${{ tree:parts/count.yml }}' }),
  );

  process.env[variableName] = 'resolved';
  try {
    assert.deepEqual(parseResolvedConfigFile(configPath), {
      plugins: {
        primary: {
          options: {
            enabled: true,
            count: 2,
            missing: null,
            tags: ['one', 'two'],
            label: 'resolved',
          },
          note: 'nested note',
        },
      },
      count: 42,
    });
  } finally {
    if (originalVariable === undefined) {
      delete process.env[variableName];
    } else {
      process.env[variableName] = originalVariable;
    }
  }
});

test('reports invalid references with their source location and reference chain', () => {
  const fixturePath = mkdtempSync(path.join(testRoot, 'errors-'));
  const configPath = path.join(fixturePath, 'fraq.yml');
  writeFileSync(configPath, YAML.stringify({ nested: { value: '${{ env:FRAQ_TEST_REFERENCE_MISSING }}' } }));

  assert.throws(
    () => parseResolvedConfigFile(configPath),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Environment variable "FRAQ_TEST_REFERENCE_MISSING" is not defined\./);
      assert.ok(error.message.includes(`Source: ${configPath} at $.nested.value`));
      assert.ok(error.message.includes(`Reference chain: ${configPath}`));
      return true;
    },
  );

  const invalidReferences = [
    ['unknown type', '${{ secret:name }}', /Unknown reference type "secret"/],
    ['invalid environment variable', '${{ env:INVALID-NAME }}', /Invalid environment variable name "INVALID-NAME"/],
    ['missing separator', '${{ env }}', /expected a type followed by ':'/],
    ['empty target', '${{ text: }}', /the target cannot be empty/],
    ['unclosed expression', '${{ env:NAME', /Unclosed reference expression/],
  ] as const;
  for (const [name, value, expectedError] of invalidReferences) {
    const invalidPath = path.join(fixturePath, `${name.replaceAll(' ', '-')}.yml`);
    writeFileSync(invalidPath, YAML.stringify({ value }));
    assert.throws(() => parseResolvedConfigFile(invalidPath), expectedError);
  }
});

test('rejects mixed, missing, malformed, and circular tree references', () => {
  const fixturePath = mkdtempSync(path.join(testRoot, 'tree-errors-'));

  writeFileSync(path.join(fixturePath, 'child.yml'), YAML.stringify({ enabled: true }));
  const mixedPath = path.join(fixturePath, 'mixed.yml');
  writeFileSync(mixedPath, YAML.stringify({ value: 'prefix-${{ tree:child.yml }}' }));
  assert.throws(
    () => parseResolvedConfigFile(mixedPath),
    /Tree reference .* must occupy the entire configuration value/,
  );

  const missingPath = path.join(fixturePath, 'missing.yml');
  writeFileSync(missingPath, YAML.stringify({ value: '${{ tree:not-found.yml }}' }));
  assert.throws(() => parseResolvedConfigFile(missingPath), /Failed to resolve structured file .*not-found\.yml/);

  const missingTextPath = path.join(fixturePath, 'missing-text.yml');
  writeFileSync(missingTextPath, YAML.stringify({ value: '${{ text:not-found.txt }}' }));
  assert.throws(() => parseResolvedConfigFile(missingTextPath), /Failed to read text reference .*not-found\.txt/);

  writeFileSync(path.join(fixturePath, 'invalid.json'), '{ invalid');
  const invalidPath = path.join(fixturePath, 'invalid.yml');
  writeFileSync(invalidPath, YAML.stringify({ value: '${{ tree:invalid.json }}' }));
  assert.throws(
    () => parseResolvedConfigFile(invalidPath),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to parse structured file .*invalid\.json/);
      assert.ok(error.message.includes(`Source: ${invalidPath} at $.value`));
      assert.ok(error.message.includes(`Reference chain: ${invalidPath} -> ${path.join(fixturePath, 'invalid.json')}`));
      return true;
    },
  );

  const unsupportedPath = path.join(fixturePath, 'unsupported.yml');
  writeFileSync(unsupportedPath, YAML.stringify({ value: '${{ tree:child.txt }}' }));
  assert.throws(() => parseResolvedConfigFile(unsupportedPath), /Unsupported structured file extension "\.txt"/);

  const circularPath = path.join(fixturePath, 'circular.yml');
  const nestedPath = path.join(fixturePath, 'nested.yml');
  writeFileSync(circularPath, YAML.stringify({ nested: '${{ tree:nested.yml }}' }));
  writeFileSync(nestedPath, YAML.stringify({ root: '${{ tree:circular.yml }}' }));
  assert.throws(
    () => parseResolvedConfigFile(circularPath),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Circular tree reference detected/);
      assert.ok(error.message.includes(`Source: ${nestedPath} at $.root`));
      assert.ok(error.message.includes(`Reference chain: ${circularPath} -> ${nestedPath} -> ${circularPath}`));
      return true;
    },
  );

  const aliasPath = path.join(fixturePath, 'alias.yml');
  writeFileSync(aliasPath, 'value: &value\n  self: *value\n');
  assert.throws(() => parseResolvedConfigFile(aliasPath), /Circular YAML value detected at \$\.value\.self/);
});

test('validates the resolved reference value with the existing configuration schema', () => {
  const fixturePath = mkdtempSync(path.join(testRoot, 'schema-'));
  const configPath = path.join(fixturePath, 'fraq.yml');
  const variableName = 'FRAQ_TEST_REFERENCE_CONFIG_VERSION';
  const originalVariable = process.env[variableName];
  writeFileSync(
    configPath,
    YAML.stringify({
      configVersion: `\${{ env:${variableName} }}`,
      fraqVersion: '0.14.0',
      milky: { url: 'http://localhost:3000' },
    }),
  );

  process.env[variableName] = '1';
  try {
    const resolved = parseResolvedConfigFile(configPath);
    assert.equal((resolved as { configVersion: unknown }).configVersion, '1');
    assert.equal(ConfigV1.safeParse(resolved).success, false);
  } finally {
    if (originalVariable === undefined) {
      delete process.env[variableName];
    } else {
      process.env[variableName] = originalVariable;
    }
  }
});

test('only resolves all configuration references when requested', async () => {
  const fixturePath = mkdtempSync(path.join(testRoot, 'resolution-mode-'));
  const configPath = path.join(fixturePath, 'fraq.yml');
  const variableName = 'FRAQ_TEST_RUNTIME_URL';
  const originalVariable = process.env[variableName];

  writeFileSync(
    path.join(fixturePath, 'plugins.yml'),
    YAML.stringify({ example: { endpoint: `\${{ env:${variableName} }}` } }),
  );
  writeFileSync(
    configPath,
    YAML.stringify({
      configVersion: 1,
      fraqVersion: '0.14.0',
      milky: { url: `\${{ env:${variableName} }}` },
      plugins: '${{ tree:plugins.yml }}',
      versions: { example: '1.0.0' },
    }),
  );

  delete process.env[variableName];
  process.chdir(fixturePath);
  try {
    const dependencyConfig = await loadConfig();
    assert.deepEqual(dependencyConfig.plugins, {
      example: { endpoint: `\${{ env:${variableName} }}` },
    });
    assert.equal('milky' in dependencyConfig, false);

    process.env[variableName] = 'http://localhost:3000';
    const runtimeConfig = await loadConfig({ resolveAllReferences: true });
    assert.equal(runtimeConfig.milky.url, 'http://localhost:3000');
    assert.deepEqual(runtimeConfig.plugins, {
      example: { endpoint: 'http://localhost:3000' },
    });
  } finally {
    process.chdir(originalCwd);
    if (originalVariable === undefined) {
      delete process.env[variableName];
    } else {
      process.env[variableName] = originalVariable;
    }
  }
});
