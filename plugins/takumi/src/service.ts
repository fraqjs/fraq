import { type Context, type Disposable, serviceToken } from '@fraqjs/fraq';
import { type FontLoader, type ImageLoader, type ImagesInput, Renderer, type RenderOptions } from '@takumi-rs/core';
import { fontFromUrl, type Node, prepareImages, type ReactElementLike } from '@takumi-rs/helpers';
import { type EmojiType, extractEmojis } from '@takumi-rs/helpers/emoji';
import { fromHtml } from '@takumi-rs/helpers/html';
import { fromJsx } from '@takumi-rs/helpers/jsx';
import type { ReactNode } from 'react';

import fs from 'node:fs/promises';

function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const filteredSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (filteredSignals.length === 0) {
    return undefined;
  }
  if (filteredSignals.length === 1) {
    return filteredSignals[0];
  }
  return AbortSignal.any(filteredSignals);
}

function getImageSources(images: ImagesInput | undefined): ImageLoader[] {
  if (!images) {
    return [];
  }
  if (Array.isArray(images)) {
    return images;
  }
  return images.sources ?? [];
}

function getImageCache(images: ImagesInput | undefined) {
  if (!images || Array.isArray(images)) {
    return undefined;
  }
  return images.cache;
}

export interface TakumiServiceOptions {
  renderDefaults?: RenderOptions;
  onFontRegisterConflict?: 'error' | 'warn-and-ignore' | 'warn-and-replace';
}

export type RenderCallOptions = RenderOptions & {
  emojiType?: EmojiType;
};

export interface PathBasedFontDetails {
  name?: string;
  path: string;
  weight?: number;
  style?: 'normal' | 'italic' | 'oblique' | `oblique ${number}deg` | (string & {});
}

export class TakumiService implements Disposable {
  static readonly token = serviceToken<TakumiService>('fraqjs/takumi/TakumiService');

  readonly renderer: Renderer;

  private readonly abortController = new AbortController();
  private readonly imageFetchCache = new Map<string, Promise<ArrayBuffer>>();
  private readonly registeredFontFamilies = new Map<string, FontLoader[]>();

  private onFontRegisterConflict: 'error' | 'warn-and-ignore' | 'warn-and-replace';

  constructor(
    private readonly options?: TakumiServiceOptions,
    private readonly ctx?: Context,
  ) {
    this.renderer = new Renderer();
    this.onFontRegisterConflict = options?.onFontRegisterConflict ?? 'warn-and-ignore';
  }

  async registerFontFamily(
    family: string,
    fonts: (string | PathBasedFontDetails | FontLoader)[],
    signal?: AbortSignal,
  ) {
    if (this.registeredFontFamilies.has(family)) {
      const message = `Font family "${family}" has already been registered.`;
      if (this.onFontRegisterConflict === 'error') {
        throw new Error(message);
      } else if (this.onFontRegisterConflict === 'warn-and-ignore') {
        if (this.ctx) {
          this.ctx.logger.warn(`${message} Ignoring new registration.`);
        } else {
          console.warn(`${message} Ignoring new registration.`);
        }
        return;
      } else if (this.onFontRegisterConflict === 'warn-and-replace') {
        if (this.ctx) {
          this.ctx.logger.warn(`${message} Replacing previous registration.`);
        } else {
          console.warn(`${message} Replacing previous registration.`);
        }
      }
    }

    signal?.throwIfAborted();
    this.registeredFontFamilies.set(
      family,
      fonts.map((font) => this.toFontLoader(family, font)),
    );
  }

  async renderJsx(jsx: ReactNode | ReactElementLike, options?: RenderCallOptions): Promise<Buffer> {
    const { emojiType, ...renderOptions } = options ?? {};
    const { node, stylesheets } = await fromJsx(jsx);
    return await this.renderNode({ node, stylesheets, renderOptions, emojiType });
  }

  async renderHtml(html: string, options?: RenderCallOptions): Promise<Buffer> {
    const { emojiType, ...renderOptions } = options ?? {};
    const { node, stylesheets } = fromHtml(html);
    return await this.renderNode({ node, stylesheets, renderOptions, emojiType });
  }

  private async renderNode(components: {
    node: Node;
    stylesheets?: string[];
    renderOptions?: RenderOptions;
    emojiType?: EmojiType;
  }): Promise<Buffer> {
    const node =
      components.emojiType === undefined ? components.node : extractEmojis(components.node, components.emojiType);
    return await this.renderer.render(
      node,
      await this.mergeRenderOptions({
        node,
        stylesheets: components.stylesheets,
        userOptions: components.renderOptions,
        images: components.emojiType !== undefined,
      }),
    );
  }

  private async mergeRenderOptions(components: {
    node: Node;
    stylesheets?: string[];
    userOptions?: RenderOptions;
    images?: boolean;
  }): Promise<RenderOptions> {
    const renderDefaults = this.options?.renderDefaults;
    const signal = combineAbortSignals(components.userOptions?.signal, this.abortController.signal);
    const images = await this.mergeImages({
      node: components.node,
      prepareImages: components.images ?? false,
      signal,
      defaultImages: renderDefaults?.images,
      userImages: components.userOptions?.images,
    });
    const fonts = this.mergeFonts(await renderDefaults?.fonts, await components.userOptions?.fonts);

    return {
      ...this.options?.renderDefaults,
      ...components.userOptions,
      stylesheets: [
        ...(this.options?.renderDefaults?.stylesheets ?? []),
        ...(components.stylesheets ?? []),
        ...(components.userOptions?.stylesheets ?? []),
      ],
      ...(fonts ? { fonts } : {}),
      ...(images ? { images } : {}),
      ...(signal ? { signal } : {}),
    } as RenderOptions;
  }

  private mergeFonts(
    defaultFonts: FontLoader[] | undefined,
    userFonts: FontLoader[] | undefined,
  ): FontLoader[] | undefined {
    const fonts = [...this.registeredFontFamilies.values()].flat();
    if (defaultFonts) {
      fonts.push(...defaultFonts);
    }
    if (userFonts) {
      fonts.push(...userFonts);
    }
    return fonts.length > 0 ? fonts : undefined;
  }

  private async mergeImages(components: {
    node: Node;
    prepareImages: boolean;
    signal?: AbortSignal;
    defaultImages?: ImagesInput;
    userImages?: ImagesInput;
  }): Promise<ImagesInput | undefined> {
    const sources = [...getImageSources(components.defaultImages), ...getImageSources(components.userImages)];
    const cache = getImageCache(components.userImages) ?? getImageCache(components.defaultImages);

    if (components.prepareImages) {
      const preparedSources = await prepareImages({
        node: components.node,
        sources,
        fetchCache: this.imageFetchCache,
        signal: components.signal,
        throwOnError: false,
      });
      return this.toImagesInput(preparedSources as ImageLoader[], cache);
    }

    return this.toImagesInput(sources, cache);
  }

  private toImagesInput(sources: ImageLoader[], cache: ReturnType<typeof getImageCache>): ImagesInput | undefined {
    if (sources.length === 0) {
      return cache === undefined ? undefined : { cache };
    }
    return cache === undefined ? sources : { sources, cache };
  }

  private toFontLoader(family: string, font: string | PathBasedFontDetails | FontLoader): FontLoader {
    if (typeof font === 'string') {
      if (font.startsWith('https://') || font.startsWith('http://')) {
        return {
          ...fontFromUrl(font),
          name: family,
        };
      }

      return {
        name: family,
        key: `${family}:${font}`,
        data: () => fs.readFile(font),
      };
    }

    if ('path' in font) {
      const { path, name = family, weight, style } = font;
      return {
        name,
        key: `${name}:${path}:${weight ?? ''}:${style ?? ''}`,
        weight,
        style,
        data: () => fs.readFile(path),
      };
    }

    return font;
  }

  dispose() {
    this.abortController.abort();
  }
}
