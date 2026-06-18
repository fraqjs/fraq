import { loadBuiltinFontsForService, TakumiService } from '../src';

import fs from 'node:fs/promises';

type CardProps = {
  title: string;
  author: string;
};

function Card({ title, author }: CardProps) {
  return (
    <div tw="flex flex-col justify-center w-full h-full px-5 bg-white text-gray-900">
      <h1 tw="font-bold" style={{ fontFamily: 'Inter' }}>
        {title}
      </h1>
      <p style={{ fontFamily: 'Roboto Mono' }}>{author}</p>
      <p tw="text-gray-500" style={{ fontFamily: 'Noto Sans SC' }}>
        由 @fraqjs/plugin-takumi 渲染. 它内置了{' '}
        <span tw="font-bold" style={{ fontFamily: 'Inter' }}>
          Inter
        </span>
        、
        <span tw="font-bold" style={{ fontFamily: 'Roboto Mono' }}>
          Roboto Mono
        </span>{' '}
        和 <span tw="font-bold">Noto Sans SC</span> 字体.
      </p>
    </div>
  );
}

const service = new TakumiService();
await loadBuiltinFontsForService(service);

const buffer = await service.renderJsx(<Card title="The Great Gatsby" author="F. Scott Fitzgerald" />, {
  devicePixelRatio: 2.0,
});

await fs.writeFile('card.png', buffer);
