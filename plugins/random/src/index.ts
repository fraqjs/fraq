import { defineCommonPlugin } from '@fraqjs/kernel';

import { RandomService, type RandomServiceOptions } from './service';

export const RandomPlugin = defineCommonPlugin({
  name: 'random',
  provides: [RandomService],
  apply(ctx, options?: RandomServiceOptions) {
    ctx.provide(RandomService, () => new RandomService(options));
  },
});

export * from './service';

export default RandomPlugin;
