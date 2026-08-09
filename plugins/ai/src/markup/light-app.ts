import z from 'zod';

/*
{
  app: 'com.tencent.miniapp_01', // discriminator
  meta: {
    detail_1: {
      desc: '【maimai谱面确认】Sky Trails  MASTER 14+', // description
      title: '哔哩哔哩', // software name
      qqdocurl: 'https://b23.tv/reFCLuF', // url, may not be present in some cases
    }
  },
}
  */
export const TencentMiniApp = z.object({
  app: z.literal('com.tencent.miniapp_01'),
  meta: z.object({
    detail_1: z.object({
      title: z.string().optional(),
      desc: z.string().optional(),
      qqdocurl: z.string().optional(),
    }),
  }),
});
export type TencentMiniApp = z.infer<typeof TencentMiniApp>;

/*
{
  app: 'com.tencent.music.lua', // discriminator
  meta: {
    music: {
      desc: 'Kotoha', // description, artist name
      tag: '网易云音乐', // software name
      title: '春を連れて (携春同行)', // music title
    }
  },
}
  */
export const TencentMusicLua = z.object({
  app: z.literal('com.tencent.music.lua'),
  meta: z.object({
    music: z.object({
      desc: z.string().optional(),
      tag: z.string().optional(),
      title: z.string().optional(),
    }),
  }),
});
export type TencentMusicLua = z.infer<typeof TencentMusicLua>;

export const LightApp = z.discriminatedUnion('app', [TencentMiniApp, TencentMusicLua]);
export type LightApp = z.infer<typeof LightApp>;
