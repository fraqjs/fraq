import { type LogBatch, type LogEntry, MAX_LOG_BYTES, MAX_LOG_LINES } from '@fraqjs/cli-protocol';

export function mergeLogs(previous: LogEntry[], batch: LogBatch): LogEntry[] {
  const retained = previous[0]?.session === batch.session ? previous : [];
  const last = retained.at(-1)?.sequence ?? 0;
  const incoming = batch.entries.filter((entry) => entry.sequence > last);
  if (!incoming.length) return retained;
  const entries = [...retained, ...incoming];
  let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let start = 0;
  while (entries.length - start > MAX_LOG_LINES || bytes > MAX_LOG_BYTES) {
    bytes -= entries[start++]?.bytes ?? 0;
  }
  return entries.slice(start);
}
