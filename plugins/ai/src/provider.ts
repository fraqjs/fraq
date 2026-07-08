import type { ProviderV3, ProviderV4 } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';

export type SupportedSDK =
  | '@ai-sdk/anthropic' // Claude
  | '@ai-sdk/deepseek' // DeepSeek
  | '@ai-sdk/google' // Gemini
  | '@ai-sdk/openai' // GPT
  | '@ai-sdk/openai-compatible'; // OpenAI Compatible

export interface ProviderConfig {
  sdk: SupportedSDK;
  options: {
    apiKey: string;
    baseURL?: string;
    [key: string]: unknown;
  };
  models: string[];
}

export async function resolveLanguageModels(name: string, config: ProviderConfig): Promise<LanguageModel[]> {
  const { sdk, options, models } = config;
  let provider: ProviderV3 | ProviderV4;
  switch (sdk) {
    case '@ai-sdk/anthropic':
      provider = (await import('@ai-sdk/anthropic')).createAnthropic(options);
      break;
    case '@ai-sdk/deepseek':
      provider = (await import('@ai-sdk/deepseek')).createDeepSeek(options);
      break;
    case '@ai-sdk/google':
      provider = (await import('@ai-sdk/google')).createGoogleGenerativeAI(options);
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
    default:
      throw new Error(`Unsupported AI SDK: ${sdk}`);
  }
  return models.map((model) => provider.languageModel(model));
}
