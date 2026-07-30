import { checkOutdatedVersions } from '../src/util/versions';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const testRoot = mkdtempSync(path.join(tmpdir(), 'fraq-cli-versions-'));

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
  });

  assert.deepEqual(result.outdated, [
    { name: 'Fraq', current: '1.0.0', latest: '2.0.0' },
    { name: 'old', current: '1.0.0', latest: '1.2.0' },
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
