import type { Config } from '../src/config';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const originalCwd = process.cwd();
const testRoot = mkdtempSync(path.join(tmpdir(), 'fraq-cli-app-'));
const { buildStartScript, generateAppPackageJson, startApp } = await import('../src/app');

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const config: Config = {
  configVersion: 1,
  fraqVersion: '1.2.3',
  milky: {
    url: 'http://localhost:3000',
    connectEvent: false,
  },
  logging: {
    minLevel: 'warn',
  },
  versions: {
    alpha: '4.5.6',
  },
  additionalDependencies: {
    zod: '4.0.0',
  },
  plugins: {
    alpha: {
      enabled: true,
    },
  },
  forks: {
    child: {
      plugins: {
        alpha: {
          enabled: false,
        },
      },
    },
  },
};

test('generates a runnable package and start script', () => {
  assert.deepEqual(generateAppPackageJson(config), {
    name: 'fraq-app',
    private: true,
    type: 'module',
    dependencies: {
      '@fraqjs/fraq': '1.2.3',
      'fraq-plugin-alpha': '4.5.6',
      zod: '4.0.0',
      '@fraqjs/color-log': '0.2.0',
    },
  });

  const script = buildStartScript(config);
  assert.match(script, /^#!\/usr\/bin\/env node/);
  assert.match(script, /installEventSource: false/);
  assert.match(script, /createColoredLogHandler\(\{ minLevel: "warn" \}\)/);
  assert.match(script, /const context1 = ctx\.fork\("child"\)/);
  assert.match(script, /await ctx\.start\(\)/);
  assert.match(script, /'SIGINT', 'SIGTERM', 'SIGBREAK'/);
  assert.match(script, /'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'/);
});

test('writes app files, installs in the app directory, and starts with Node', {
  skip: process.platform === 'win32',
}, async () => {
  const appDirectory = path.join(testRoot, 'app');
  const packageManagerPath = path.join(testRoot, 'package-manager');
  const installCwdPath = path.join(testRoot, 'install-cwd');
  writeFileSync(packageManagerPath, `#!/bin/sh\npwd > ${JSON.stringify(installCwdPath)}\nexit 0\n`);
  chmodSync(packageManagerPath, 0o755);

  const fraqDirectory = path.join(appDirectory, 'node_modules', '@fraqjs', 'fraq');
  const colorLogDirectory = path.join(appDirectory, 'node_modules', '@fraqjs', 'color-log');
  const pluginDirectory = path.join(appDirectory, 'node_modules', 'fraq-plugin-alpha');
  for (const directory of [fraqDirectory, colorLogDirectory, pluginDirectory]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
  }
  writeFileSync(
    path.join(fraqDirectory, 'index.js'),
    `
export class Context {
  static fromUrl() { return new Context(); }
  logger = { info() {}, error() {} };
  install() {}
  fork() { return new Context(); }
  async start() {}
  async stop() {}
}
`.trim(),
  );
  writeFileSync(path.join(colorLogDirectory, 'index.js'), 'export function createColoredLogHandler() {}\n');
  writeFileSync(path.join(pluginDirectory, 'index.js'), 'export default {};\n');

  process.chdir(testRoot);
  try {
    const exitCode = await startApp(config, {
      name: 'npm',
      commandPath: packageManagerPath,
    });

    assert.equal(exitCode, 0);
    assert.equal(realpathSync(readFileSync(installCwdPath, 'utf-8').trim()), realpathSync(appDirectory));
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(appDirectory, 'package.json'), 'utf-8')),
      generateAppPackageJson(config),
    );
    assert.equal(readFileSync(path.join(appDirectory, 'index.js'), 'utf-8'), `${buildStartScript(config)}\n`);
  } finally {
    process.chdir(originalCwd);
  }
});

test('does not start the app when installation fails', { skip: process.platform === 'win32' }, async () => {
  const packageManagerPath = path.join(testRoot, 'failing-package-manager');
  writeFileSync(packageManagerPath, '#!/bin/sh\nexit 7\n');
  chmodSync(packageManagerPath, 0o755);

  process.chdir(testRoot);
  try {
    await assert.rejects(
      startApp(config, {
        name: 'npm',
        commandPath: packageManagerPath,
      }),
      /Package manager install failed with exit code 7/,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test('forwards termination signals and preserves the signal exit code', {
  skip: process.platform === 'win32',
}, async (t) => {
  const workerRoot = path.join(testRoot, 'signal-worker');
  const workerApp = path.join(workerRoot, 'app');
  const packageManagerPath = path.join(workerRoot, 'package-manager');
  const startedPath = path.join(workerRoot, 'started');
  const stoppedPath = path.join(workerRoot, 'stopped');
  mkdirSync(workerRoot, { recursive: true });
  writeFileSync(path.join(workerRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(packageManagerPath, '#!/bin/sh\nexit 0\n');
  chmodSync(packageManagerPath, 0o755);

  const fraqDirectory = path.join(workerApp, 'node_modules', '@fraqjs', 'fraq');
  const colorLogDirectory = path.join(workerApp, 'node_modules', '@fraqjs', 'color-log');
  for (const directory of [fraqDirectory, colorLogDirectory]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
  }
  writeFileSync(
    path.join(fraqDirectory, 'index.js'),
    `
import { writeFileSync } from 'node:fs';

let keepAlive;

export class Context {
  static fromUrl() { return new Context(); }
  logger = { info() {}, error() {} };
  install() {}
  fork() { return new Context(); }
  async start() {
    writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));
    keepAlive = setInterval(() => {}, 1000);
  }
  async stop() {
    clearInterval(keepAlive);
    writeFileSync(${JSON.stringify(stoppedPath)}, 'stopped');
  }
}
`.trim(),
  );
  writeFileSync(path.join(colorLogDirectory, 'index.js'), 'export function createColoredLogHandler() {}\n');

  const runnerPath = path.join(workerRoot, 'runner.ts');
  const appModuleUrl = pathToFileURL(path.resolve(originalCwd, 'packages/cli/src/app/index.ts')).href;
  const signalConfig: Config = {
    configVersion: 1,
    fraqVersion: '1.2.3',
    milky: {
      url: 'http://localhost:3000',
      connectEvent: false,
    },
    logging: {
      minLevel: 'info',
    },
    versions: {},
  };
  writeFileSync(
    runnerPath,
    `
import { startApp } from ${JSON.stringify(appModuleUrl)};

process.exitCode = await startApp(${JSON.stringify(signalConfig)}, {
  name: 'npm',
  commandPath: ${JSON.stringify(packageManagerPath)},
});
`.trim(),
  );

  const worker = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), runnerPath], {
    cwd: workerRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  worker.stdout.on('data', (data) => {
    output += data.toString();
  });
  worker.stderr.on('data', (data) => {
    output += data.toString();
  });
  t.after(() => {
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
    }
  });

  const deadline = Date.now() + 5_000;
  while (!existsSync(startedPath)) {
    if (worker.exitCode !== null || worker.signalCode !== null) {
      assert.fail(`App runner exited before startup completed.\n${output}`);
    }
    if (Date.now() >= deadline) {
      assert.fail(`Timed out waiting for the generated app to start.\n${output}`);
    }
    await delay(20);
  }

  worker.kill('SIGTERM');
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('close', (code, signal) => resolve({ code, signal }));
  });

  assert.deepEqual(result, { code: 143, signal: null }, output);
  assert.equal(readFileSync(stoppedPath, 'utf-8'), 'stopped');
});
