import type { LogBatch } from '@fraqjs/cli-protocol';
import { ArrowDownIcon, CircleAlertIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { base, login } from '../client';
import { mergeLogs } from '../logs';
import { useCliSession } from '../session';

export function LogsPage() {
  const { logs, setLogs, gap, setGap, following, setFollowing, cursor, logScrollTop } = useCliSession();
  const [logConnected, setLogConnected] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = logScrollTop.current;
  }, [logScrollTop]);

  useEffect(() => {
    const query = new URLSearchParams();
    if (cursor.current.session) query.set('session', cursor.current.session);
    if (cursor.current.after !== undefined) query.set('after', String(cursor.current.after));
    const stream = new EventSource(`${base}/api/logs/stream?${query}`);
    stream.addEventListener('logs', (event) => {
      const batch = JSON.parse((event as MessageEvent).data) as LogBatch;
      setLogConnected(true);
      if (batch.gap) setGap(true);
      setLogs((previous) => mergeLogs(previous, batch));
      cursor.current = { session: batch.session, after: batch.cursor };
    });
    stream.addEventListener('auth', login);
    stream.onerror = () => setLogConnected(false);
    return () => {
      stream.close();
      setLogConnected(false);
    };
  }, [cursor, setGap, setLogs]);

  const latestSequence = logs.at(-1)?.sequence;
  useEffect(() => {
    if (latestSequence !== undefined && following && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [latestSequence, following]);

  return (
    <section className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-label="实时日志">
      <div className="flex h-12 items-center justify-between gap-3 border-b px-4 text-sm">
        <div className="flex items-center gap-3">
          实时日志{' '}
          <Badge variant="secondary" className="rounded-md font-normal">
            {logConnected ? '已连接' : '等待重连'}
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">{logs.length}/1000</span>
      </div>
      {gap && (
        <Alert className="rounded-none border-x-0 border-t-0 text-amber-700" role="status">
          <CircleAlertIcon />
          <AlertDescription className="text-amber-700">部分日志已超出缓存范围，仅显示可用内容。</AlertDescription>
        </Alert>
      )}
      <div
        className="h-[clamp(280px,57vh,650px)] overflow-auto p-3 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-4"
        ref={viewport}
        role="region"
        tabIndex={0}
        aria-label="日志内容"
        onScroll={(event) => {
          const element = event.currentTarget;
          logScrollTop.current = element.scrollTop;
          setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
        }}
      >
        {logs.length === 0 ? (
          <p className="text-muted-foreground">等待日志输出…</p>
        ) : (
          logs.map((entry) => (
            <div
              className="grid grid-cols-[58px_42px_minmax(0,1fr)] gap-1 sm:grid-cols-[64px_52px_minmax(0,1fr)] sm:gap-2.5"
              key={`${entry.session}:${entry.sequence}`}
            >
              <time className="text-[11px] text-muted-foreground">
                {new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })}
              </time>
              <span className="text-[11px] text-muted-foreground">{entry.source.toUpperCase()}</span>
              <span
                className={cn(
                  'whitespace-pre-wrap [overflow-wrap:anywhere]',
                  entry.stream === 'stderr' && 'text-destructive',
                )}
              >
                {entry.text || ' '}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="flex items-center justify-end gap-3 border-t px-4 py-3.5">
        <Button variant="outline" className="rounded-md" onClick={() => setFollowing(true)} disabled={following}>
          <ArrowDownIcon />
          回到底部
        </Button>
      </div>
    </section>
  );
}
