import type { ProviderV3, ProviderV4 } from '@ai-sdk/provider';
import type { ImageModel, LanguageModel } from 'ai';

export type SupportedSDK =
  | '@ai-sdk/alibaba' // Qwen
  | '@ai-sdk/anthropic' // Claude
  | '@ai-sdk/bytedance' // Doubao
  | '@ai-sdk/deepseek' // DeepSeek
  | '@ai-sdk/google' // Gemini
  | '@ai-sdk/moonshotai' // Kimi
  | '@ai-sdk/openai' // GPT
  | '@ai-sdk/openai-compatible' // OpenAI Compatible
  | '@ai-sdk/xai'; // Grok

export interface ProviderConfig {
  sdk: SupportedSDK;
  options: {
    apiKey: string;
    baseURL?: string;
    [key: string]: unknown;
  };
  models: string[];
  imageModels?: string[];
}

export interface ResolvedModels {
  language: Record<string, LanguageModel>;
  image: Record<string, ImageModel>;
}

export async function resolveModels(name: string, config: ProviderConfig): Promise<ResolvedModels> {
  const { sdk, options, models, imageModels } = config;
  let provider: ProviderV3 | ProviderV4;
  switch (sdk) {
    case '@ai-sdk/alibaba':
      provider = (await import('@ai-sdk/alibaba')).createAlibaba(options);
      break;
    case '@ai-sdk/anthropic':
      provider = (await import('@ai-sdk/anthropic')).createAnthropic(options);
      break;
    case '@ai-sdk/bytedance':
      provider = (await import('@ai-sdk/bytedance')).createByteDance(options);
      break;
    case '@ai-sdk/deepseek':
      provider = (await import('@ai-sdk/deepseek')).createDeepSeek(options);
      break;
    case '@ai-sdk/google':
      provider = (await import('@ai-sdk/google')).createGoogleGenerativeAI(options);
      break;
    case '@ai-sdk/moonshotai':
      provider = (await import('@ai-sdk/moonshotai')).createMoonshotAI(options);
      break;
    case '@ai-sdk/openai':
      provider = (await import('@ai-sdk/openai')).createOpenAI(options);
      break;
    case '@ai-sdk/openai-compatible':
      if (!options.baseURL) {
        throw new Error('`baseURL` is required for OpenAI Compatible SDK');
      }
      provider = (await import('@ai-sdk/openai-compatible')).createOpenAICompatible({
        ...options,
        baseURL: options.baseURL,
        name: name,
      });
      break;
    case '@ai-sdk/xai':
      provider = (await import('@ai-sdk/xai')).createXai(options);
      break;
    default:
      throw new Error(`Unsupported AI SDK: ${sdk}`);
  }

  const language: Record<string, LanguageModel> = {};
  for (const modelId of models) {
    language[`${name}/${modelId}`] = provider.languageModel(modelId);
  }

  const image: Record<string, ImageModel> = {};
  for (const modelId of imageModels ?? []) {
    image[`${name}/${modelId}`] = provider.imageModel(modelId);
  }

  return { language, image };
}
