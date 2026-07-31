export interface PluginRegistry {
  version: number;
  updatedAt: string;
  categories: string[];
  plugins: Record<string, RawPlugin>;
}

export interface RawPlugin {
  name: string;
  version: string;
  updatedAt: string;
  description: string;
  category: string;
  repository: string;
  market: { unlisted: boolean };
}

export interface PluginEntry {
  id: string;
  name: string;
  version: string;
  updatedAt: string;
  description: string;
  category: string;
  repository: string;
}

export const CATEGORY_LABELS: Record<string, string> = {
  infrastructure: '基础服务',
  development: '开发与运维',
  management: '管理工具',
  information: '资讯与生活',
  media: '媒体与创作',
  ai: '人工智能',
  social: '社交与互动',
  entertainment: '娱乐与游戏',
  'game-tools': '游戏辅助',
  utilities: '工具与效率',
};

export function toPluginEntry(id: string, plugin: RawPlugin): PluginEntry {
  return {
    id: id,
    name: plugin.name,
    version: plugin.version,
    updatedAt: plugin.updatedAt,
    description: plugin.description,
    category: plugin.category,
    repository: plugin.repository,
  };
}

export function isOfficial(plugin: PluginEntry): boolean {
  return plugin.id.startsWith('fraqjs/');
}

export function officialPluginSlug(plugin: PluginEntry): string {
  return plugin.id.slice('fraqjs/'.length);
}
