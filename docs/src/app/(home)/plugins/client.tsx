'use client';

import type { LucideIcon } from 'lucide-react';
import * as lucide from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const REGISTRY_URL = 'https://registry.fraq.dev/plugins.json';

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
  updatedAt: string;
  categories: string[];
  plugins: Record<string, RawPlugin>;
}

interface PluginEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string | null;
  repository: string;
}

function isOfficial(plugin: PluginEntry): boolean {
  return plugin.id.startsWith('fraqjs/');
}

function pluginHref(plugin: PluginEntry): string {
  if (isOfficial(plugin)) {
    const slug = plugin.id.slice('fraqjs/'.length);
    return `/docs/plugins/${slug}`;
  }
  return plugin.repository;
}

const CATEGORY_LABELS: Record<string, string> = {
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

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  infrastructure: lucide.ServerIcon,
  development: lucide.CodeXmlIcon,
  management: lucide.GaugeIcon,
  information: lucide.NewspaperIcon,
  media: lucide.PaletteIcon,
  ai: lucide.BotIcon,
  social: lucide.MessagesSquareIcon,
  entertainment: lucide.Dice3Icon,
  'game-tools': lucide.Gamepad2Icon,
  utilities: lucide.ZapIcon,
};

const SESSION_KEY = 'fraq-plugin-order';

function shuffled<T extends { id: string }>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function useShuffledPlugins(plugins: PluginEntry[]): PluginEntry[] {
  const [shuffledPlugins, setShuffledPlugins] = useState<PluginEntry[]>([]);

  useEffect(() => {
    if (plugins.length === 0) {
      setShuffledPlugins([]);
      return;
    }

    let ordered: PluginEntry[] | undefined;
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        const ids = JSON.parse(stored) as unknown;
        if (Array.isArray(ids) && ids.every((id): id is string => typeof id === 'string')) {
          const map = new Map(plugins.map((plugin) => [plugin.id, plugin]));
          const restored = ids.flatMap((id) => {
            const plugin = map.get(id);
            return plugin ? [plugin] : [];
          });
          const appended = plugins.filter((plugin) => !ids.includes(plugin.id));
          if (restored.length > 0) {
            ordered = [...restored, ...appended];
          }
        }
      }
    } catch {
      // sessionStorage unavailable (e.g. private browsing restrictions) — fall through
    }

    const result = ordered ?? shuffled(plugins);
    setShuffledPlugins(result);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(result.map((plugin) => plugin.id)));
    } catch {
      // Ignore read-only or unavailable storage.
    }
  }, [plugins]);

  return shuffledPlugins;
}

export function PluginMarketplace() {
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const shuffledPlugins = useShuffledPlugins(plugins);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    fetch(REGISTRY_URL, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to fetch plugins registry: ${res.status}`);
        return (await res.json()) as PluginRegistry;
      })
      .then((data) => {
        if (cancelled) return;

        const listedPlugins: PluginEntry[] = Object.entries(data.plugins)
          .filter(([, plugin]) => !plugin.market.unlisted)
          .map(([id, plugin]) => ({
            id,
            name: plugin.name,
            version: plugin.version,
            description: plugin.description,
            category: plugin.category,
            repository: plugin.repository,
          }));

        setUpdatedAt(data.updatedAt);
        setPlugins(listedPlugins);
        setCategories(data.categories);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const updatedAtLocale = updatedAt ? new Date(updatedAt).toLocaleString() : null;

  // Only show categories that have at least one listed plugin
  const usedCategories = categories.filter((cat) => plugins.some((p) => p.category === cat));

  const filtered =
    activeCategory === '__official__'
      ? shuffledPlugins.filter(isOfficial)
      : activeCategory
        ? shuffledPlugins.filter((p) => p.category === activeCategory)
        : shuffledPlugins;

  return (
    <main className="w-full">
      <section className="mx-auto w-full max-w-5xl px-6 py-16 md:py-24">
        {/* Header */}
        <div className="mb-10 max-w-2xl">
          <div className="mb-4 flex items-center gap-3">
            <lucide.PuzzleIcon className="size-8 text-fd-muted-foreground" />
            <h1 className="text-4xl font-semibold tracking-normal text-fd-foreground md:text-5xl">插件市场</h1>
          </div>
          <p className="text-lg text-fd-muted-foreground">浏览和发现由社区构建的 Fraq 插件，扩展你的机器人功能。</p>
          <p className="mt-1 text-sm text-fd-muted-foreground">
            {loading
              ? '正在加载插件...'
              : error
                ? '插件信息加载失败，请稍后重试。'
                : `共 ${plugins.length} 个插件 · 最后更新于 ${updatedAtLocale ?? '未知时间'}`}
          </p>
        </div>

        {/* Category filter */}
        <div className="mb-8 flex flex-wrap gap-2">
          <button onClick={() => setActiveCategory(null)} className={categoryPillClass(activeCategory === null)}>
            全部
          </button>
          <button
            onClick={() => setActiveCategory('__official__')}
            className={categoryPillClass(activeCategory === '__official__')}
          >
            <lucide.BadgeCheckIcon className="size-3 shrink-0" />
            官方插件
          </button>
          {usedCategories.map((cat) => {
            const CategoryIcon = CATEGORY_ICONS[cat] ?? lucide.TagIcon;
            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={categoryPillClass(activeCategory === cat)}
              >
                <CategoryIcon className="size-3 shrink-0" />
                {CATEGORY_LABELS[cat] ?? cat}
              </button>
            );
          })}
        </div>

        {/* Plugin grid */}
        {loading ? (
          <p className="text-fd-muted-foreground">正在加载插件...</p>
        ) : error ? (
          <p className="text-fd-muted-foreground">暂时无法加载插件信息。</p>
        ) : filtered.length === 0 ? (
          <p className="text-fd-muted-foreground">该分类下暂无插件。</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((plugin) => (
              <PluginCard key={plugin.id} plugin={plugin} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function categoryPillClass(active: boolean): string {
  return [
    'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition-colors',
    active
      ? 'border-fd-primary bg-fd-primary text-fd-primary-foreground'
      : 'border-fd-border bg-fd-background text-fd-muted-foreground hover:bg-fd-muted hover:text-fd-foreground',
  ].join(' ');
}

function PluginCard({ plugin }: { plugin: PluginEntry }) {
  const official = isOfficial(plugin);
  const href = pluginHref(plugin);

  const cardClass =
    'group flex flex-col gap-3 rounded-lg border bg-fd-card p-4 text-fd-card-foreground transition-colors hover:border-fd-primary/50 hover:bg-fd-accent/30 border-fd-border';

  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {official && <lucide.BadgeCheckIcon className="size-3.5 shrink-0 text-fd-primary" />}
          <p className="truncate font-mono text-xs text-fd-muted-foreground">{plugin.id}</p>
        </div>
        {!official && (
          <lucide.ExternalLinkIcon className="size-3.5 shrink-0 text-fd-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </div>

      <p className="text-sm leading-relaxed text-fd-foreground">{plugin.description}</p>

      <div className="mt-auto flex items-center justify-between gap-2">
        {plugin.category ? (
          <span className="rounded-full border border-fd-border bg-fd-muted/60 px-2 py-0.5 text-xs text-fd-muted-foreground">
            {CATEGORY_LABELS[plugin.category] ?? plugin.category}
          </span>
        ) : (
          <span />
        )}
        <span className="font-mono text-xs text-fd-muted-foreground">v{plugin.version}</span>
      </div>
    </>
  );

  if (official) {
    return (
      <Link href={href} className={cardClass}>
        {inner}
      </Link>
    );
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cardClass}>
      {inner}
    </a>
  );
}
