import * as lucide from 'lucide-react';

import { CATEGORY_LABELS, isOfficial, type PluginEntry } from '@/app/(home)/plugins/shared';

export function PluginCard({
  plugin,
  onOpenReadme,
}: {
  plugin: PluginEntry;
  onOpenReadme: (plugin: PluginEntry) => void;
}) {
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
