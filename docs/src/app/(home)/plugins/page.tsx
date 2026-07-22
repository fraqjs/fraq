import type { Metadata } from 'next';

import { PluginMarketplace } from './client';

export const metadata: Metadata = {
  metadataBase: new URL('https://fraq.dev'),
  title: 'Fraq | 插件市场',
  description: '浏览和发现由社区构建的 Fraq 插件，扩展你的机器人功能。',
};

export default function PluginsPage() {
  return <PluginMarketplace />;
}
