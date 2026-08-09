import type { Config, ContextConfig, FilterConfig } from '../config';
import { normalizePluginName } from '../dependency';
import { getWorkspacePluginImportSpecifier, isWorkspacePlugin } from '../workspace-plugins';
import { compileActivationResolver } from './activation';

function buildFilterExpression(config: FilterConfig): string {
  if (typeof config === 'string') {
    return `filter.${config}()`;
  }
  if ('friends' in config) {
    return `filter.friend(${config.friends.map((id) => JSON.stringify(id)).join(', ')})`;
  }
  if ('groups' in config) {
    return `filter.group(${config.groups.map((id) => JSON.stringify(id)).join(', ')})`;
  }
  if ('senders' in config) {
    return `filter.sender(${config.senders.map((id) => JSON.stringify(id)).join(', ')})`;
  }
  if ('or' in config) {
    return `filter.or(${config.or.map(buildFilterExpression).join(', ')})`;
  }
  if ('and' in config) {
    return `filter.and(${config.and.map(buildFilterExpression).join(', ')})`;
  }
  if ('not' in config) {
    return `filter.not(${buildFilterExpression(config.not)})`;
  }
  throw new Error(`Invalid filter configuration: ${JSON.stringify(config)}`);
}

export function buildStartScript(config: Config): string {
  const lines: string[] = [];

  lines.push(
    `
#!/usr/bin/env node

import { Context, filter } from '@fraqjs/fraq';
import { createColoredLogHandler } from '@fraqjs/color-log';
    `.trim(),
  );
  lines.push('');

  if (config.activation !== undefined) {
    lines.push(`const activationResolver = ${compileActivationResolver(config.activation)};`);
    lines.push('');
  }

  lines.push(
    `
const ctx = Context.fromUrl(${JSON.stringify(config.milky.url)}, {
  accessToken: ${JSON.stringify(config.milky.accessToken)},
  installEventSource: ${JSON.stringify(config.milky.connectEvent)},
  routing: ${config.activation === undefined ? 'undefined' : '{ activationResolver }'},
  logHandler: createColoredLogHandler({ minLevel: ${JSON.stringify(config.logging.minLevel)} }),
});
    `.trim(),
  );
  lines.push('');

  let nextContextId = 0;
  function buildContextPart(parentContextName: string, contextConfig: ContextConfig) {
    for (const [pluginName, pluginConfig] of Object.entries(contextConfig.plugins ?? {})) {
      const packageName = normalizePluginName(pluginName);
      const importSpecifier = isWorkspacePlugin(config, pluginName)
        ? getWorkspacePluginImportSpecifier(config, pluginName, packageName)
        : packageName;
      lines.push(
        `${parentContextName}.install((await import(${JSON.stringify(importSpecifier)})).default, ${JSON.stringify(pluginConfig)});`,
      );
    }
    for (const [forkName, forkConfig] of Object.entries(contextConfig.forks ?? {})) {
      const forkContextName = `context${++nextContextId}`;
      const filterArgument = forkConfig.filter ? `, ${buildFilterExpression(forkConfig.filter)}` : '';
      lines.push(`const ${forkContextName} = ${parentContextName}.fork(${JSON.stringify(forkName)}${filterArgument});`);
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
