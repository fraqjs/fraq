import { buildStartScript } from '../src/app/start-script';
import type { Config } from '../src/config';

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

/** Execute generated ESM, substituting only the host Context and external logging. */
export async function runGeneratedApp(
  t: TestContext,
  config: Config,
  probes: { events?: object[]; routes?: object[]; modules?: Record<string, string> } = {},
): Promise<{ contexts: { path: string[]; accepts: boolean[] }[]; activations: unknown[]; plugins: string[] }> {
  const script = buildStartScript(config);
  const root = mkdtempSync(path.join(tmpdir(), 'fraq-generated-app-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filterModule = new URL('../../fraq/src/core/filter.ts', import.meta.url).href;
  const modules = {
    '@fraqjs/fraq': `
      export { filter } from ${JSON.stringify(filterModule)};
      const events = ${JSON.stringify(probes.events ?? [])};
      const routes = ${JSON.stringify(probes.routes ?? [])};
      export const Context = {
        fromUrl(_url, options) {
          const contexts = [];
          const plugins = [];
          function create(path, predicates) {
            contexts.push({ path, predicates });
            return {
              fork(name, predicate) { return create([...path, name], predicate ? [...predicates, predicate] : predicates); },
              install(plugin) { plugins.push(plugin.name); },
              logger: { info() {}, error() {} },
              async stop() {},
              async start() {
                console.log(JSON.stringify({
                  contexts: contexts.map(({ path, predicates }) => ({ path,
                    accepts: events.map(event => predicates.every(predicate => predicate[event.event_type]?.(event) === true))
                  })),
                  activations: routes.map(route => options.routing?.activationResolver(route) ?? null),
                  plugins
                }));
              }
            };
          }
          return create(['root'], []);
        }
      };
    `,
    '@fraqjs/color-log': 'export const createColoredLogHandler = () => () => {};',
  };
  for (const [name, source] of Object.entries(modules)) {
    const directory = path.join(root, 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', main: './index.mjs' }));
    writeFileSync(path.join(directory, 'index.mjs'), source);
  }
  for (const [name, directory] of Object.entries(probes.modules ?? {})) {
    const target = path.join(root, 'node_modules', name);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(directory, target, 'junction');
  }
  const entry = path.join(root, 'index.mjs');
  writeFileSync(entry, script);
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), entry], {
    cwd: root,
    timeout: 10_000,
  });
  return JSON.parse(stdout);
}
