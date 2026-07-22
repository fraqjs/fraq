'use client';

import { BadgeCheckIcon, ExternalLinkIcon, PuzzleIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import type { PluginEntry } from './page';

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
  return useState<PluginEntry[]>(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        const ids: string[] = JSON.parse(stored) as string[];
        const map = new Map(plugins.map((p) => [p.id, p]));
        // Restore stored order; append any plugins not yet in the stored list
        // biome-ignore lint/style/noNonNullAssertion: We've already checked that the map has the id
        const ordered = ids.flatMap((id) => (map.has(id) ? [map.get(id)!] : []));
        const appended = plugins.filter((p) => !ids.includes(p.id));
        return [...ordered, ...appended];
      }
    } catch {
      // sessionStorage unavailable (e.g. private browsing restrictions) — fall through
    }
    const result = shuffled(plugins);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(result.map((p) => p.id)));
    } catch {
      // ignore write failures
    }
    return result;
  })[0];
}

interface Props {
  plugins: PluginEntry[];
  categories: string[];
}

export function PluginMarketplace({ plugins, categories }: Props) {
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const shuffledPlugins = useShuffledPlugins(plugins);

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
            <PuzzleIcon className="size-8 text-fd-muted-foreground" />
            <h1 className="text-4xl font-semibold tracking-normal text-fd-foreground md:text-5xl">插件市场</h1>
          </div>
          <p className="text-lg text-fd-muted-foreground">浏览和发现由社区构建的 Fraq 插件，扩展你的机器人功能。</p>
          <p className="mt-1 text-sm text-fd-muted-foreground">共 {plugins.length} 个插件</p>
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
            <BadgeCheckIcon className="size-3 shrink-0" />
            官方插件
          </button>
          {usedCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={categoryPillClass(activeCategory === cat)}
            >
              {CATEGORY_LABELS[cat] ?? cat}
            </button>
          ))}
        </div>

        {/* Plugin grid */}
        {filtered.length === 0 ? (
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

  const cardClass = [
    'group flex flex-col gap-3 rounded-lg border bg-fd-card p-4 text-fd-card-foreground transition-colors hover:border-fd-primary/50 hover:bg-fd-accent/30',
    official ? 'border-fd-foreground/20' : 'border-fd-border',
  ].join(' ');

  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {official && <BadgeCheckIcon className="size-3.5 shrink-0 text-fd-primary" />}
          <p className="truncate font-mono text-xs text-fd-muted-foreground">{plugin.id}</p>
        </div>
        {!official && (
          <ExternalLinkIcon className="size-3.5 shrink-0 text-fd-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
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
