import type { Config } from '../config';
import type { ContextConfig } from '../config/v1';
import { normalizePluginName } from '../dependency';

export function buildStartScript(config: Config): string {
  const lines: string[] = [];

  lines.push(
    `
#!/usr/bin/env node

import { Context } from '@fraqjs/fraq';
import { createColoredLogHandler } from '@fraqjs/color-log';

const ctx = Context.fromUrl(${JSON.stringify(config.milky.url)}, {
  accessToken: ${JSON.stringify(config.milky.accessToken)},
  installEventSource: ${JSON.stringify(config.milky.connectEvent)},
  logHandler: createColoredLogHandler({ minLevel: ${JSON.stringify(config.logging.minLevel)} }),
});
    `.trim(),
  );
  lines.push('');

  let nextContextId = 0;
  function buildContextPart(parentContextName: string, contextConfig: ContextConfig) {
    for (const [pluginName, pluginConfig] of Object.entries(contextConfig.plugins ?? {})) {
      lines.push(
        `${parentContextName}.install((await import(${JSON.stringify(normalizePluginName(pluginName))})).default, ${JSON.stringify(pluginConfig)});`,
      );
    }
    for (const [forkName, forkConfig] of Object.entries(contextConfig.forks ?? {})) {
      const forkContextName = `context${++nextContextId}`;
      lines.push(`const ${forkContextName} = ${parentContextName}.fork(${JSON.stringify(forkName)});`);
      buildContextPart(forkContextName, forkConfig);
    }
  }
  buildContextPart('ctx', config);

  lines.push('');
  lines.push(
    `
let shutdownPromise;

async function shutdown(signal) {
  shutdownPromise ??= (async () => {
    ctx.logger.info(\`Shutting down after receiving \${signal}...\`);
    await ctx.stop();
  })();

  try {
    await shutdownPromise;
    process.exit(0);
  } catch (error) {
    ctx.logger.error('Failed to shut down cleanly.', error);
    process.exit(1);
  }
}

const terminationSignals =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

for (const signal of terminationSignals) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

await ctx.start();
    `.trim(),
  );

  return lines.join('\n');
}
