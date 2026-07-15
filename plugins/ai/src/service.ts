import type { ImageModel, LanguageModel } from 'ai';

export interface AiServiceOptions {
  models: Record<string, LanguageModel>;
  images: Record<string, ImageModel>;
  aliases: Record<string, string>;
  defaultModel?: string;
  defaultImageModel?: string;
}

export class AiService {
  private readonly languageModels: Record<string, LanguageModel>;
  private readonly imageModels: Record<string, ImageModel>;
  private readonly aliases: Record<string, string>;
  private readonly defaultLanguageModel: LanguageModel | undefined;
  private readonly defaultImageModel: ImageModel | undefined;

  constructor(options: AiServiceOptions) {
    this.languageModels = options.models;
    this.imageModels = options.images;
    this.aliases = options.aliases;

    if (Object.keys(options.models).length === 0 && Object.keys(options.images).length === 0) {
      throw new Error('No models configured: provide at least one language or image model.');
    }

    this.defaultLanguageModel = options.defaultModel
      ? this.lookup(options.defaultModel, options.models, 'Model')
      : Object.values(options.models)[0];

    this.defaultImageModel = options.defaultImageModel
      ? this.lookup(options.defaultImageModel, options.images, 'Image model')
      : Object.values(options.images)[0];

    for (const [alias, target] of Object.entries(options.aliases)) {
      if (!options.models[target] && !options.images[target]) {
        throw new Error(`Invalid alias "${alias}": target model "${target}" does not exist.`);
      }
    }
  }

  private lookup<T>(name: string, registry: Record<string, T>, kind: string): T {
    const direct = registry[name];
    if (direct) return direct;
    const aliasedName = this.aliases[name];
    if (aliasedName) {
      const aliased = registry[aliasedName];
      if (aliased) return aliased;
    }
    throw new Error(`${kind} not found: ${name}`);
  }

  model(name?: string): LanguageModel {
    if (!name) {
      if (!this.defaultLanguageModel) throw new Error('No language model configured.');
      return this.defaultLanguageModel;
    }
    return this.lookup(name, this.languageModels, 'Model');
  }

  image(name?: string): ImageModel {
    if (!name) {
      if (!this.defaultImageModel) throw new Error('No image model configured.');
      return this.defaultImageModel;
    }
    return this.lookup(name, this.imageModels, 'Image model');
  }

  hasModel(name: string): boolean {
    return !!this.languageModels[name] || !!(this.aliases[name] && this.languageModels[this.aliases[name]]);
  }

  hasImage(name: string): boolean {
    return !!this.imageModels[name] || !!(this.aliases[name] && this.imageModels[this.aliases[name]]);
  }

  models(): string[] {
    return Object.keys(this.languageModels);
  }

  images(): string[] {
    return Object.keys(this.imageModels);
  }
}
