import chokidar from 'chokidar';

const watchExtensions = /\.(mjs|mts|js|jsx|ts|tsx|json|css|scss|sass|less|styl)$/i;

export interface PreviewWatcher {
  update(files: string[]): void;
  close(): Promise<void>;
}

export function createPreviewWatcher(options: {
  files: string[];
  debounceMs?: number;
  onChange: (changedFile: string) => void | Promise<void>;
}): PreviewWatcher {
  const watcher = chokidar.watch([], {
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 25,
    },
  });

  let watched = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let pendingChangedFile = '';

  watcher.on('all', (_event, filePath) => {
    pendingChangedFile = filePath;
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      void options.onChange(pendingChangedFile);
    }, options.debounceMs ?? 120);
  });

  watcher.on('error', (error) => {
    console.error(`Watcher error: ${error instanceof Error ? error.message : String(error)}`);
  });

  function update(files: string[]) {
    const next = new Set(files.map(normalizeWatchedPath).filter(Boolean));
    const toAdd = [...next].filter((file) => !watched.has(file));
    const toRemove = [...watched].filter((file) => !next.has(file));

    if (toAdd.length > 0) {
      watcher.add(toAdd);
    }

    if (toRemove.length > 0) {
      watcher.unwatch(toRemove);
    }

    watched = next;
  }

  update(options.files);

  return {
    update,
    close: () => watcher.close(),
  };
}

function normalizeWatchedPath(filePath: string) {
  if (!watchExtensions.test(filePath)) {
    return '';
  }

  if (filePath.includes('/node_modules/') || filePath.includes('\\node_modules\\')) {
    return '';
  }

  return filePath;
}
