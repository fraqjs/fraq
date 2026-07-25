'use client';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import type { LucideIcon } from 'lucide-react';
import * as lucide from 'lucide-react';
import Markdown, { RuleType } from 'markdown-to-jsx';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useMDXComponents } from '@/components/mdx';
import { docsContentRoute, gitConfig } from '@/lib/shared';

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

function officialPluginSlug(plugin: PluginEntry): string {
  return plugin.id.slice('fraqjs/'.length);
}

function pluginHref(plugin: PluginEntry): string {
  if (isOfficial(plugin)) {
    return `/docs/plugins/${officialPluginSlug(plugin)}`;
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

interface ReadmeState {
  text: string | null;
  loading: boolean;
  error: boolean;
}

function ReadmeDrawer({
  plugin,
  open,
  readme,
  onClose,
}: {
  plugin: PluginEntry | null;
  open: boolean;
  readme: ReadmeState;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const mdxComponents = useMDXComponents();

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [open]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Reset scroll when a new plugin is opened
  // biome-ignore lint/correctness/useExhaustiveDependencies: Resetting scroll on plugin change is intentional, and we don't want to reset when readme changes.
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [open, plugin?.id]);

  if (!plugin) return null;

  const official = isOfficial(plugin);
  const slug = official ? officialPluginSlug(plugin) : null;
  const npmId = plugin.name;
  const githubUrl = official
    ? `https://github.com/${gitConfig.user}/${gitConfig.repo}/tree/${gitConfig.branch}/plugins/${slug}`
    : plugin.repository;
  const docsUrl = official ? pluginHref(plugin) : null;
  const npmUrl = `https://www.npmjs.com/package/${npmId}`;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={[
          'fixed inset-0 z-40 bg-black/40 transition-opacity duration-300',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        ].join(' ')}
      />

      {/* Drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${plugin.name} README`}
        className={[
          'fixed z-50 flex flex-col bg-fd-background shadow-xl transition-transform duration-300',
          // Mobile: bottom sheet
          'bottom-0 left-0 right-0 max-h-[85svh] rounded-t-xl border-t border-fd-border',
          // Desktop: right panel
          'md:bottom-0 md:left-auto md:right-0 md:top-0 md:max-h-none md:w-1/2 md:rounded-none md:border-l md:border-t-0',
          // Animation
          open ? 'translate-y-0 md:translate-x-0' : 'translate-y-full md:translate-y-0 md:translate-x-full',
        ].join(' ')}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-fd-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs text-fd-muted-foreground">{plugin.id}</p>
            <p className="mt-0.5 text-sm text-fd-foreground">{plugin.description}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-md p-1.5 text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
          >
            <lucide.XIcon className="size-4" />
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex shrink-0 items-center gap-2 border-b border-fd-border px-5 py-3">
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-muted/60 px-3 py-1.5 text-xs text-fd-foreground transition-colors hover:bg-fd-accent"
            >
              <lucide.BookOpenIcon className="size-3.5" />
              文档
            </a>
          )}
          <a
            href={npmUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-muted/60 px-3 py-1.5 text-xs text-fd-foreground transition-colors hover:bg-fd-accent"
          >
            <lucide.PackageIcon className="size-3.5" />
            npm
          </a>
          {githubUrl && (
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-muted/60 px-3 py-1.5 text-xs text-fd-foreground transition-colors hover:bg-fd-accent"
            >
              <lucide.GitBranchIcon className="size-3.5" />
              GitHub
            </a>
          )}
          <span className="ml-auto font-mono text-xs text-fd-muted-foreground">v{plugin.version}</span>
        </div>

        {/* Documentation content */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {readme.loading && (
            <div className="flex items-center gap-2 text-sm text-fd-muted-foreground">
              <lucide.LoaderCircleIcon className="size-4 animate-spin" />
              正在加载 README…
            </div>
          )}
          {readme.error && (
            <p className="text-sm text-fd-muted-foreground">
              README 加载失败，请前往官方文档、npm 或 GitHub 查看。
            </p>
          )}
          {readme.text && official ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-fd-muted-foreground">
                以下是官方文档的原始 Markdown 内容，请点击“文档”按钮查看完整内容。
              </p>
              {/* divider */}
              <div className="h-px bg-fd-border" />
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fd-foreground">
                {readme.text}
              </pre>
            </div>
          ) : readme.text ? (
            <Markdown
              options={{
                overrides: { ...mdxComponents, img: () => null },
                renderRule(next, node, _renderChildren, state) {
                  if (node.type === RuleType.codeBlock) {
                    return (
                      <div key={state.key} className="[&_code]:text-[0.7109375rem]">
                        <DynamicCodeBlock lang={node.lang || 'text'} code={node.text} />
                      </div>
                    );
                  }
                  return next();
                },
              }}
              className="prose prose-sm dark:prose-invert max-w-none text-fd-foreground [&_a]:text-fd-primary"
            >
              {readme.text}
            </Markdown>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function PluginMarketplace() {
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const shuffledPlugins = useShuffledPlugins(plugins);

  const [drawerPlugin, setDrawerPlugin] = useState<PluginEntry | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [readme, setReadme] = useState<ReadmeState>({ text: null, loading: false, error: false });

  const openDrawer = useCallback((plugin: PluginEntry) => {
    setDrawerPlugin(plugin);
    setDrawerOpen(false);
    setReadme({ text: null, loading: true, error: false });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => setDrawerOpen(true));
    });
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setTimeout(() => setDrawerPlugin(null), 300);
  }, []);

  useEffect(() => {
    if (!drawerPlugin) return;

    const controller = new AbortController();
    const contentUrl = isOfficial(drawerPlugin)
      ? `${docsContentRoute}/plugins/${officialPluginSlug(drawerPlugin)}/content.md`
      : `https://cdn.jsdelivr.net/npm/${drawerPlugin.name}@${drawerPlugin.version}/README.md`;

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
  const usedCategories = categories.filter((cat) => plugins.some((p) => p.category === cat));

  const filtered =
    activeCategory === '__official__'
      ? shuffledPlugins.filter(isOfficial)
      : activeCategory
        ? shuffledPlugins.filter((p) => p.category === activeCategory)
        : shuffledPlugins;

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

function PluginCard({ plugin, onOpenReadme }: { plugin: PluginEntry; onOpenReadme: (plugin: PluginEntry) => void }) {
  const official = isOfficial(plugin);

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
          <a
            href={plugin.repository}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label="在新标签页中打开"
            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <lucide.ExternalLinkIcon className="size-3.5 text-fd-muted-foreground" />
          </a>
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

  return (
    <button type="button" onClick={() => onOpenReadme(plugin)} className={`${cardClass} w-full text-left`}>
      {inner}
    </button>
  );
}
