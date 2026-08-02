import chokidar from 'chokidar';

import path from 'node:path';

export interface ConfigSourceRegistry {
  update(files: Iterable<string>): void;
  close(): Promise<void>;
}

export function createConfigSourceRegistry(options: {
  files: Iterable<string>;
  onChange: () => void;
  onError?: (error: unknown) => void;
  debounceMs?: number;
}): ConfigSourceRegistry {
  const watcher = chokidar.watch([], {
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 25,
    },
    ignoreInitial: true,
  });

  let watchedFiles = new Set<string>();
  let changeTimer: NodeJS.Timeout | undefined;

  watcher.on('all', () => {
    if (changeTimer) {
      clearTimeout(changeTimer);
    }
    changeTimer = setTimeout(options.onChange, options.debounceMs ?? 120);
  });
  watcher.on('error', (error) => options.onError?.(error));

  function update(files: Iterable<string>): void {
    const nextFiles = new Set(Array.from(files, (file) => path.resolve(file)));
    const addedFiles = [...nextFiles].filter((file) => !watchedFiles.has(file));
    const removedFiles = [...watchedFiles].filter((file) => !nextFiles.has(file));

    if (addedFiles.length > 0) {
      watcher.add(addedFiles);
    }
    if (removedFiles.length > 0) {
      watcher.unwatch(removedFiles);
    }
    watchedFiles = nextFiles;
  }

  update(options.files);

  return {
    update,
    async close() {
      if (changeTimer) {
        clearTimeout(changeTimer);
      }
      await watcher.close();
    },
  };
}
