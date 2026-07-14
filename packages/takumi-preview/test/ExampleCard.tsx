/// <reference types="@takumi-rs/helpers/jsx" />

import { PluginName, PreviewModuleId } from './dependency';

export interface ExampleCardProps {
  title: string;
  subtitle: string;
}

export default function ExampleCard(props: ExampleCardProps) {
  return (
    <div tw="flex flex-col justify-center w-full h-full px-12 bg-white text-gray-900">
      <h1 tw="m-0 text-5xl font-bold" style={{ fontFamily: 'Inter' }}>
        {props.title}
      </h1>
      <p tw="mt-5 text-3xl text-gray-500" style={{ fontFamily: 'Noto Sans SC' }}>
        {props.subtitle}
      </p>
      <p tw="text-gray-400" style={{ fontFamily: 'Roboto Mono' }}>
        Powered by <u>{PluginName}</u> & <code>{PreviewModuleId}</code>
      </p>
    </div>
  );
}

export const previewProps: ExampleCardProps = {
  title: 'Takumi Preview',
  subtitle: '修改卡片内容, 并检查渲染效果.',
};

export const previewRenderOptions = {
  width: 1200,
  height: 600,
  devicePixelRatio: 2,
};
