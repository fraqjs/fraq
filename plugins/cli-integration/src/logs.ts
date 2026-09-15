import { type ControlClient, LOG_POLL_MS, type LogCursor, MAX_LOG_BYTES } from '@fraqjs/cli-protocol';

export function createLogStream(
  client: ControlClient,
  cursor: LogCursor,
  options: { signal: AbortSignal; expiresAt: number; onClose(): void; pollMs?: number },
): { body: ReadableStream<Uint8Array>; close(): void } {
  const encoder = new TextEncoder();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    options.signal.removeEventListener('abort', close);
    controller.close();
    options.onClose();
  };
  const poll = async () => {
    try {
      if (Date.now() >= options.expiresAt) {
        controller.enqueue(encoder.encode('event: auth\ndata: {}\n\n'));
        close();
        return;
      }
      const batch = await client.request('logs', cursor);
      if (stopped) return;
      if (Date.now() >= options.expiresAt) {
        close();
        return;
      }
      const data = encoder.encode(
        `id: ${batch.session}:${batch.cursor}\nevent: logs\ndata: ${JSON.stringify(batch)}\n\n`,
      );
      if ((controller.desiredSize ?? 0) < data.byteLength) {
        close();
        return;
      }
      controller.enqueue(data);
      cursor = { session: batch.session, after: batch.cursor };
      timer = setTimeout(() => void poll(), options.pollMs ?? LOG_POLL_MS);
    } catch {
      if (!stopped) close();
    }
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        options.signal.addEventListener('abort', close, { once: true });
        queueMicrotask(() => {
          if (options.signal.aborted) close();
          else if (!stopped) void poll();
        });
      },
      cancel() {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        options.signal.removeEventListener('abort', close);
        options.onClose();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: MAX_LOG_BYTES + 1024 * 1024 }),
  );
  return { body, close };
}
