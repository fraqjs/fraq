import { tsImport } from 'tsx/esm/api';

import type { PreviewTarget, TakumiPreviewModule } from './types';

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function loadPreviewTarget(filePath: string): Promise<PreviewTarget> {
  const resolvedPath = path.resolve(filePath);
  const fileUrl = pathToFileURL(resolvedPath).href;
  const importedUrls = new Set<string>();
  const module = (await tsImport(`${fileUrl}?t=${Date.now()}`, {
    parentURL: import.meta.url,
    onImport(url) {
      importedUrls.add(url);
    },
  })) as Partial<TakumiPreviewModule>;

  if (typeof module.default !== 'function') {
    throw new Error(`Preview module must default-export a React component: ${resolvedPath}`);
  }

  return {
    filePath: resolvedPath,
    fileUrl,
    importedFilePaths: [
      ...new Set([
        resolvedPath,
        ...Array.from(importedUrls)
          .filter((url) => url.startsWith('file:'))
          .map((url) => fileURLToPath(url)),
      ]),
    ],
    module: module as TakumiPreviewModule,
  };
}
