'use client';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import * as lucide from 'lucide-react';
import Markdown, { RuleType } from 'markdown-to-jsx';
import { useEffect, useRef } from 'react';

import { useMDXComponents } from '@/components/mdx';
import { gitConfig } from '@/lib/shared';

export interface PluginEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string | null;
  repository: string;
  updatedAt: string | null;
}

export interface ReadmeState {
  text: string | null;
  loading: boolean;
  error: boolean;
}

export function isOfficial(plugin: PluginEntry): boolean {
  return plugin.id.startsWith('fraqjs/');
}

export function officialPluginSlug(plugin: PluginEntry): string {
  return plugin.id.slice('fraqjs/'.length);
}

function pluginHref(plugin: PluginEntry): string {
  if (isOfficial(plugin)) {
    return `/docs/plugins/${officialPluginSlug(plugin)}`;
  }
  return plugin.repository;
}

export function ReadmeDrawer({
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
            <p className="text-sm text-fd-muted-foreground">README 加载失败，请前往官方文档、npm 或 GitHub 查看。</p>
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
