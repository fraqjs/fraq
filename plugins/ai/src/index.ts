import { definePlugin } from '@fraqjs/fraq';
import type { LanguageModel } from 'ai';

import { type ProviderConfig, resolveLanguageModels } from './provider';
import { AiService } from './service';

type LanguageModelInstance = Exclude<LanguageModel, string>;

export interface AiPluginOptions {
  providers: Record<string, ProviderConfig | Record<string, LanguageModelInstance>>;
  aliases?: Record<string, string>;
  defaultModel?: string;
}

export const AiPlugin = definePlugin({
  name: 'ai',
  provides: [AiService],
  async apply(ctx, options: AiPluginOptions) {
    const models: Record<string, LanguageModel> = {};
    for (const [name, config] of Object.entries(options.providers)) {
      if ('sdk' in config && typeof config.sdk === 'string') {
        const providerConfig = config as ProviderConfig;
        const resolvedModels = await resolveLanguageModels(name, providerConfig);
        resolvedModels.forEach((model, idx) => {
          const modelName = `${name}/${providerConfig.models[idx]}`;
          models[modelName] = model;
        });
      } else {
        Object.entries(config).forEach(([modelName, model]) => {
          models[`${name}/${modelName}`] = model;
        });
      }
    }
    if (Object.keys(models).length === 0) {
      throw new Error('No language models resolved from the provided AI SDK configurations.');
    }
    ctx.provide(
      AiService,
      new AiService({
        models: models,
        aliases: options.aliases ?? {},
        defaultModel: options.defaultModel ?? Object.keys(models)[0],
      }),
    );
  },
});

export * from './protocol/toolset';
export * from './provider';
export * from './service';

export default AiPlugin;
