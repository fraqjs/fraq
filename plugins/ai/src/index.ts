import { definePlugin } from '@fraqjs/fraq';
import type { ImageModel, LanguageModel } from 'ai';

import { type ProviderConfig, resolveModels } from './provider';
import { AiService } from './service';

type LanguageModelInstance = Exclude<LanguageModel, string>;
type ImageModelInstance = Exclude<ImageModel, string>;

export interface DirectProviderConfig {
  models?: Record<string, LanguageModelInstance>;
  imageModels?: Record<string, ImageModelInstance>;
}

export interface AiPluginOptions {
  providers: Record<string, ProviderConfig | DirectProviderConfig>;
  aliases?: Record<string, string>;
  defaultModel?: string;
  defaultImageModel?: string;
}

export const AiPlugin = definePlugin({
  name: 'ai',
  provides: [AiService],
  async apply(ctx, options: AiPluginOptions) {
    const languageModels: Record<string, LanguageModel> = {};
    const imageModels: Record<string, ImageModel> = {};

    for (const [name, config] of Object.entries(options.providers)) {
      if ('sdk' in config && typeof config.sdk === 'string') {
        const providerConfig = config as ProviderConfig;
        const resolved = await resolveModels(name, providerConfig);
        Object.assign(languageModels, resolved.language);
        Object.assign(imageModels, resolved.image);
      } else {
        const direct = config as DirectProviderConfig;
        for (const [modelName, model] of Object.entries(direct.models ?? {})) {
          languageModels[`${name}/${modelName}`] = model;
        }
        for (const [modelName, model] of Object.entries(direct.imageModels ?? {})) {
          imageModels[`${name}/${modelName}`] = model;
        }
      }
    }

    if (Object.keys(languageModels).length === 0 && Object.keys(imageModels).length === 0) {
      throw new Error('No models resolved from the provided AI configurations.');
    }

    ctx.provide(
      AiService,
      new AiService({
        models: languageModels,
        images: imageModels,
        aliases: options.aliases ?? {},
        defaultModel: options.defaultModel ?? Object.keys(languageModels)[0],
        defaultImageModel: options.defaultImageModel,
      }),
    );
  },
});

export * from './protocol/toolset';
export * from './provider';
export * from './service';

export default AiPlugin;
