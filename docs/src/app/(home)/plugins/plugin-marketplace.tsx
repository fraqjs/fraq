'use client';

import type { LucideIcon } from 'lucide-react';
import * as lucide from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { PluginCard } from '@/app/(home)/plugins/plugin-card';
import {
  CATEGORY_LABELS,
  isOfficial,
  type PluginEntry,
  type PluginRegistry,
  toPluginEntry,
} from '@/app/(home)/plugins/shared';
import { ReadmeDrawer, type ReadmeState } from './readme-drawer';

const REGISTRY_URL = 'https://registry.fraq.dev/plugins.json';

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
const SORT_KEY = 'fraq-plugin-sort';

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
  const [sortByUpdated, setSortByUpdated] = useState(false);

  // Hydrate sort preference from localStorage after mount
  useEffect(() => {
    try {
      setSortByUpdated(localStorage.getItem(SORT_KEY) === 'updated');
    } catch {
      // localStorage unavailable (e.g. private browsing restrictions) — ignore
    }
  }, []);
  const shuffledPlugins = useShuffledPlugins(plugins);

  const [drawerPlugin, setDrawerPlugin] = useState<PluginEntry | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [readme, setReadme] = useState<ReadmeState>({ text: null, loading: false, error: false });

  const openDrawer = useCallback((plugin: PluginEntry) => {
    setDrawerPlugin(plugin);
    setDrawerOpen(false);
    setReadme({ text: null, loading: !isOfficial(plugin), error: false });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => setDrawerOpen(true));
    });
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setTimeout(() => setDrawerPlugin(null), 300);
  }, []);

  useEffect(() => {
    if (!drawerPlugin || isOfficial(drawerPlugin)) return;

    const controller = new AbortController();
    const contentUrl = `https://cdn.jsdelivr.net/npm/${drawerPlugin.name}@${drawerPlugin.version}/README.md`;

    fetch(contentUrl, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        return res.text();
      })
      .then((text) => setReadme({ text, loading: false, error: false }))
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setReadme({ text: null, loading: false, error: true });
      });

    return () => controller.abort();
  }, [drawerPlugin]);

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
          .map(([id, plugin]) => toPluginEntry(id, plugin));

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
  const usedCategories = categories.filter((cat) => plugins.some((p) => p.category === cat));

  const displayPlugins = sortByUpdated
    ? [...shuffledPlugins].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    : shuffledPlugins;

  const filtered =
    activeCategory === '__official__'
      ? displayPlugins.filter(isOfficial)
      : activeCategory
        ? displayPlugins.filter((p) => p.category === activeCategory)
        : displayPlugins;

  return (
    <main className="w-full">
      <ReadmeDrawer plugin={drawerPlugin} open={drawerOpen} readme={readme} onClose={closeDrawer} />

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
            <lucide.TagIcon className="size-3 shrink-0" />
            全部
          </button>
          <button
            onClick={() => setActiveCategory('__official__')}
            className={categoryPillClass(activeCategory === '__official__')}
          >
            <lucide.BadgeCheckIcon className="size-3 shrink-0" />
            官方插件 ({plugins.filter(isOfficial).length})
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
                {CATEGORY_LABELS[cat] ?? cat} ({plugins.filter((p) => p.category === cat).length})
              </button>
            );
          })}
        </div>

        {/* Sort control */}
        {!loading && !error && (
          <div className="-mt-4 mb-6 flex items-center justify-end">
            <button
              onClick={() => {
                setSortByUpdated((v) => {
                  const next = !v;
                  try {
                    next ? localStorage.setItem(SORT_KEY, 'updated') : localStorage.removeItem(SORT_KEY);
                  } catch {
                    // localStorage unavailable — ignore
                  }
                  return next;
                });
              }}
              className={[
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors',
                sortByUpdated
                  ? 'bg-fd-primary/10 text-fd-primary'
                  : 'text-fd-muted-foreground hover:text-fd-foreground',
              ].join(' ')}
            >
              <lucide.ArrowDownNarrowWideIcon className="size-3.5 shrink-0" />
              {sortByUpdated ? '按更新时间排序' : '随机排序'}
            </button>
          </div>
        )}

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
              <PluginCard key={plugin.id} plugin={plugin} onOpenReadme={openDrawer} />
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
