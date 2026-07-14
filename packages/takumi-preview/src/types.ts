import type { RenderCallOptions, TakumiService, TakumiServiceOptions } from '@fraqjs/plugin-takumi';
import type { ComponentType } from 'react';

export type PreviewRenderOptions = RenderCallOptions;
export type PreviewEmojiType = NonNullable<RenderCallOptions['emojiType']>;

export interface TakumiPreviewModule<Props = Record<string, unknown>> {
  default: ComponentType<Props>;
  previewProps?: Props;
  previewRenderOptions?: PreviewRenderOptions;
  previewServiceOptions?: TakumiServiceOptions;
  previewEmojiType?: PreviewEmojiType;
  previewSetup?: (service: TakumiService) => void | Promise<void>;
}

export interface PreviewTarget {
  filePath: string;
  fileUrl: string;
  importedFilePaths: string[];
  module: TakumiPreviewModule;
}

export interface PreviewMeta {
  filePath: string;
  renderMs: number;
  renderedAt: string;
  renderOptions: PreviewRenderOptions;
}
