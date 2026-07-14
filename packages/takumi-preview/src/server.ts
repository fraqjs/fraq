import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { type PreviewErrorInfo, renderErrorText, renderPreviewPage, toPreviewErrorInfo } from './html';
import { type RenderPreviewResult, renderPreview } from './render';
import { loadPreviewTarget } from './targets';
import type { PreviewMeta } from './types';
import { createPreviewWatcher, type PreviewWatcher } from './watch';

const textEncoder = new TextEncoder();

export interface PreviewServerOptions {
  filePath: string;
  host: string;
  port: number;
}

export interface PreviewServer {
  app: Hono;
  server: ReturnType<typeof serve>;
  url: string;
}

type EventSink = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
};

export async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
  const app = new Hono();
  let latestMeta: PreviewMeta | undefined;
  let latestError: unknown;
  let latestErrorInfo: PreviewErrorInfo | undefined;
  let latestImage: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let watcher: PreviewWatcher | undefined;
  const sinks = new Set<EventSink>();
  // biome-ignore lint/suspicious/noConfusingVoidType: This type is used to allow both types of onChange handlers, which can return either void or a promise.
  let refreshQueue: Promise<void | RenderPreviewResult> = Promise.resolve();

  function applyRenderSuccess(result: RenderPreviewResult, importedFilePaths: string[]) {
    latestMeta = result.meta;
    latestImage = result.image;
    latestError = undefined;
    latestErrorInfo = undefined;

    if (!watcher) {
      watcher = createPreviewWatcher({
        files: importedFilePaths,
        onChange: () => {
          void refreshPreview();
        },
      });
    } else {
      watcher.update(importedFilePaths);
    }
  }

  function applyRenderError(error: unknown, importedFilePaths: string[] = [options.filePath]) {
    latestError = error;
    latestErrorInfo = toPreviewErrorInfo(error);
    latestImage = Buffer.alloc(0);

    if (!watcher) {
      watcher = createPreviewWatcher({
        files: importedFilePaths,
        onChange: () => {
          void refreshPreview();
        },
      });
    }
  }

  async function refreshPreview() {
    try {
      const target = await loadPreviewTarget(options.filePath);
      const result = await renderPreview(target);
      applyRenderSuccess(result, target.importedFilePaths);
      broadcast('reload', {});
      return result;
    } catch (error) {
      applyRenderError(error);
      broadcast('reload', {});
      return undefined;
    }
  }

  function broadcast(event: string, data: Record<string, unknown>) {
    for (const sink of sinks) {
      if (sink.closed) {
        sinks.delete(sink);
        continue;
      }

      sink.controller.enqueue(textEncoder.encode(`event: ${event}\n`));
      sink.controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(data)}\n`));
      sink.controller.enqueue(textEncoder.encode('\n'));
    }
  }

  app.get('/', (c) => c.html(renderPreviewPage(options.filePath)));

  app.get('/preview.png', async (c) => {
    if (latestError) {
      return c.text(renderErrorText(latestError), 500);
    }

    if (latestImage.byteLength === 0) {
      refreshQueue = refreshQueue.then(() => refreshPreview());
      await refreshQueue;

      if (latestError) {
        return c.text(renderErrorText(latestError), 500);
      }
    }

    return new Response(latestImage, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'image/png',
      },
    });
  });

  app.get('/meta.json', (c) => {
    if (latestErrorInfo) {
      return c.json(
        {
          error: latestErrorInfo,
        },
        500,
      );
    }

    if (!latestMeta) {
      return c.json({
        filePath: options.filePath,
        renderMs: 0,
        renderedAt: null,
        renderOptions: null,
      });
    }

    return c.text(JSON.stringify(latestMeta, null, 2), 200, {
      'Content-Type': 'application/json',
    });
  });

  app.get('/events', (c) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const sink: EventSink = { controller, closed: false };
        sinks.add(sink);
        controller.enqueue(textEncoder.encode(`event: ready\ndata: {}\n\n`));
        c.req.raw.signal.addEventListener('abort', () => {
          sink.closed = true;
          sinks.delete(sink);
          try {
            controller.close();
          } catch {
            // ignore stream close races
          }
        });
      },
      cancel() {
        // handled by abort listener
      },
    });

    return new Response(stream, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
      },
    });
  });

  try {
    const target = await loadPreviewTarget(options.filePath);
    const result = await renderPreview(target);
    applyRenderSuccess(result, target.importedFilePaths);
  } catch (error) {
    applyRenderError(error);
  }

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const nextServer = serve(
      {
        fetch: app.fetch,
        hostname: options.host,
        port: options.port,
      },
      () => {
        nextServer.off('error', reject);
        resolve(nextServer);
      },
    );

    nextServer.once('error', reject);
  });

  return {
    app,
    server,
    url: `http://${options.host}:${options.port}`,
  };
}
