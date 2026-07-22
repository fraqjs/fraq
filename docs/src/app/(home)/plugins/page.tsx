import type { Metadata } from 'next';

import { PluginMarketplace } from './client';

export const metadata: Metadata = {
  metadataBase: new URL('https://fraq.dev'),
  title: '插件市场 - Fraq',
  description: '浏览和发现由社区构建的 Fraq 插件，扩展你的机器人功能。',
};

const REGISTRY_URL = 'https://registry.fraq.dev/plugins.json';

export interface PluginEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string | null;
  repository: string;
}

interface RawPlugin {
  name: string;
  version: string;
  description: string;
  category: string | null;
  repository: string;
  market: { unlisted: boolean };
}

interface PluginRegistry {
  version: number;
  categories: string[];
  plugins: Record<string, RawPlugin>;
}

async function fetchPlugins(): Promise<{ plugins: PluginEntry[]; categories: string[] }> {
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) throw new Error(`Failed to fetch plugins registry: ${res.status}`);
  const data = (await res.json()) as PluginRegistry;

  const plugins: PluginEntry[] = Object.entries(data.plugins)
    .filter(([, p]) => !p.market.unlisted)
    .map(([id, p]) => ({
      id,
      name: p.name,
      version: p.version,
      description: p.description,
      category: p.category,
      repository: p.repository,
    }));

  return { plugins, categories: data.categories };
}

export default async function PluginsPage() {
  const { plugins, categories } = await fetchPlugins();
  return <PluginMarketplace plugins={plugins} categories={categories} />;
}
