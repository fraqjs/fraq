import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const tsxPath = import.meta.resolve('tsx');

function runCli(root: string, args: string[]) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxPath, cliPath, ...args], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10_000,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('normal startup and the first watch startup fail without using an older session', {
  timeout: 30_000,
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fraq-cli-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of [
    [
      '@fraqjs/fraq',
      `
      export const filter = {};
      export const Context = {
        fromUrl(url) {
          return {
            logger: { info() {}, error() {} },
            async start() {
              if (url.includes('4000')) throw new Error('bad candidate');
              setTimeout(() => process.exit(7), 50);
            },
            async stop() {}
          };
        }
      };
    `,
    ],
    ['@fraqjs/color-log', 'export const createColoredLogHandler = () => {};'],
  ] as const) {
    const directory = path.join(root, 'app', 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', main: './index.js' }));
    writeFileSync(path.join(directory, 'index.js'), source);
  }
  const configuration = {
    configVersion: 1,
    packageManager: 'npm',
    fraqVersion: '1.0.0',
    milky: { url: 'http://localhost:3000' },
  };
  const configPath = path.join(root, 'fraq.json');
  const savedPath = path.join(root, 'app', 'last-success.json');
  writeFileSync(configPath, JSON.stringify(configuration));
  const first = await runCli(root, ['start', '--no-install', '--frozen-lockfile']);
  assert.equal(first.code, 7, first.stderr);
  assert.equal(existsSync(savedPath), false);
  const oldEntry = 'start-00000000-0000-0000-0000-000000000000.mjs';
  writeFileSync(path.join(root, 'app', oldEntry), readFileSync(path.join(root, 'app', 'index.js')));
  const saved = JSON.stringify({ version: 1, directory: '.', entryPoint: oldEntry, fingerprint: '', sources: [] });
  writeFileSync(savedPath, saved);

  writeFileSync(configPath, '{bad JSON');
  const broken = await runCli(root, ['start']);
  assert.equal(broken.code, 1, broken.stderr);
  assert.doesNotMatch(broken.stderr, /Falling back to the last successful runtime/);
  assert.equal(readFileSync(configPath, 'utf8'), '{bad JSON');
  assert.equal(readFileSync(savedPath, 'utf8'), saved);

  const watched = await runCli(root, ['start', '--watch']);
  assert.equal(watched.code, 1, watched.stderr);
  assert.doesNotMatch(watched.stderr, /Falling back|waiting for a configuration change/);

  rmSync(configPath);
  const missing = await runCli(root, ['start']);
  assert.equal(missing.code, 1, missing.stderr);
  assert.doesNotMatch(missing.stderr, /Falling back to the last successful runtime/);

  writeFileSync(configPath, JSON.stringify({ ...configuration, milky: { url: 'http://localhost:4000' } }));
  const failed = await runCli(root, ['start', '--no-install', '--frozen-lockfile']);
  assert.equal(failed.code, 1, failed.stderr);
  assert.doesNotMatch(failed.stderr, /Falling back to the last successful runtime/);
  assert.equal(readFileSync(savedPath, 'utf8'), saved);
});
