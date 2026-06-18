import { definePlugin } from '@fraqjs/fraq';

import { TakumiService, type TakumiServiceOptions } from './service';

import { createRequire } from 'node:module';

const fontsBase = '@fraqjs/takumi-builtin-fonts/files';

export interface TakumiPluginOptions extends TakumiServiceOptions {
  loadBuiltinFonts?: boolean;
}

export async function loadBuiltinFontsForService(service: TakumiService) {
  const require = createRequire(import.meta.url);
  await service.registerFontFamily('Inter', [
    require.resolve(`${fontsBase}/Inter-VariableFont_opsz,wght.ttf`),
    require.resolve(`${fontsBase}/Inter-Italic-VariableFont_opsz,wght.ttf`),
  ]);
  await service.registerFontFamily('Roboto Mono', [
    require.resolve(`${fontsBase}/RobotoMono-VariableFont_wght.ttf`),
    require.resolve(`${fontsBase}/RobotoMono-Italic-VariableFont_wght.ttf`),
  ]);
  await service.registerFontFamily('Noto Sans SC', [require.resolve(`${fontsBase}/NotoSansSC-VariableFont_wght.ttf`)]);
}

export const TakumiPlugin = definePlugin({
  name: 'takumi',
  provides: [TakumiService],
  async apply(ctx, options?: TakumiPluginOptions) {
    const service = new TakumiService(options, ctx);
    if (options?.loadBuiltinFonts ?? true) {
      ctx.logger.debug('Loading built-in fonts...');
      await loadBuiltinFontsForService(service);
    }
    ctx.provide(TakumiService, service);
  },
});

export * from './service';

export default TakumiPlugin;
