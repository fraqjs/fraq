import type { AppStatus, ConfigDocument, LogBatch, LogCursor, LogEntry } from '@fraqjs/cli-protocol';
import { ArrowDownIcon, CircleAlertIcon, InfoIcon, LoaderCircleIcon, RotateCwIcon, SaveIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import fraqLogo from '../../../../assets/brand/fraq-logo.svg';
import { mergeLogs } from './logs';

const base = '/webui/cli-integration';
function login() {
  window.location.assign(`/webui/login/?returnTo=${encodeURIComponent(`${base}/`)}`);
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    signal: AbortSignal.timeout(15_000),
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (response.status === 401) {
    login();
    throw new Error('登录已过期。');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`);
  return body;
}
const stateNames = { starting: '正在启动', running: '运行中', restarting: '正在重启', stopped: '已停止' };

export function App() {
  const [tab, setTab] = useState<'config' | 'logs'>('config');
  const [status, setStatus] = useState<AppStatus>();
  const [connected, setConnected] = useState(false);
  const [document, setDocument] = useState<ConfigDocument>();
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState<'saving' | 'restarting' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logConnected, setLogConnected] = useState(false);
  const [gap, setGap] = useState(false);
  const [following, setFollowing] = useState(true);
  const dirty = useRef(false);
  const documentRef = useRef<ConfigDocument | undefined>(undefined);
  const cursor = useRef<LogCursor>({});
  const viewport = useRef<HTMLDivElement>(null);
  const restartGeneration = useRef<number | undefined>(undefined);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadConfig = useCallback(async (discard = false) => {
    try {
      const next = await api<ConfigDocument>('/config');
      if (dirty.current && !discard) return;
      documentRef.current = next;
      setDocument(next);
      setContent(next.content);
      dirty.current = false;
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法读取配置。');
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let previousGeneration: number | undefined;
    let wasConnected = false;
    const poll = async () => {
      try {
        const next = await api<AppStatus>('/status');
        if (stopped) return;
        setConnected(true);
        setStatus(next);
        if (!wasConnected || previousGeneration !== next.generation) void loadConfig();
        if (
          restartGeneration.current !== undefined &&
          (next.generation > restartGeneration.current || (!next.busy && next.error))
        ) {
          restartGeneration.current = undefined;
          clearTimeout(restartTimer.current);
          setBusy(null);
          setNotice(next.fallback ? '新配置未能启动，已回退。' : '重启完成。');
        }
        previousGeneration = next.generation;
        wasConnected = true;
      } catch {
        if (!stopped) setConnected(false);
        wasConnected = false;
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(restartTimer.current);
    };
  }, [loadConfig]);

  useEffect(() => {
    if (tab !== 'logs') return;
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
  }, [tab]);

  const latestSequence = logs.at(-1)?.sequence;
  useEffect(() => {
    if (tab === 'logs' && latestSequence !== undefined && following && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [tab, latestSequence, following]);

  const save = async () => {
    if (!document) return;
    setBusy('saving');
    setError('');
    setNotice('');
    try {
      const saved = await api<ConfigDocument>('/config', {
        method: 'PUT',
        body: JSON.stringify({ content, revision: document.revision }),
      });
      documentRef.current = saved;
      setDocument(saved);
      dirty.current = false;
      setNotice('配置已保存。应用结果见运行状态和日志。');
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setBusy(null);
    }
  };
  const restart = async () => {
    setBusy('restarting');
    setError('');
    setNotice('');
    restartGeneration.current = status?.generation;
    try {
      await api('/restart', { method: 'POST' });
      setNotice('重启请求已接受，正在等待恢复连接。');
      restartTimer.current = setTimeout(() => {
        restartGeneration.current = undefined;
        setBusy(null);
        setNotice('重启后尚未恢复，请查看终端或日志。');
      }, 75_000);
    } catch (error) {
      restartGeneration.current = undefined;
      setBusy(null);
      setError(error instanceof Error ? error.message : '重启请求失败。');
    }
  };
  const disabled = Boolean(busy) || !connected || status?.busy;
  const isDirty = document !== undefined && content !== document.content;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-7 sm:py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="flex items-center gap-2 text-xl font-normal tracking-tight text-muted-foreground">
          <img src={fraqLogo} alt="Fraq" width={254} height={101} className="h-6 w-auto" />
          <span>CLI</span>
        </h1>
        <div className="flex items-center gap-3 sm:gap-4">
          <Badge
            variant="outline"
            className={cn(
              'gap-2 rounded-md border-transparent font-normal text-muted-foreground',
              connected && status?.fallback && 'text-amber-700',
            )}
            role="status"
          >
            <span
              aria-hidden="true"
              className={cn('size-1.5 rounded-full bg-current', connected && !status?.fallback && 'bg-green-600')}
            />
            {connected && status ? (status.fallback ? '运行旧配置' : stateNames[status.state]) : '连接中断'}
          </Badge>
          <Button variant="outline" className="rounded-md" onClick={() => void restart()} disabled={disabled}>
            {busy === 'restarting' ? (
              <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
            ) : (
              <RotateCwIcon />
            )}
            {busy === 'restarting' ? '等待重启…' : '立即重启'}
          </Button>
        </div>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === 'config' || value === 'logs') setTab(value);
        }}
        className="gap-0"
      >
        <TabsList
          variant="line"
          aria-label="管理功能"
          className="mb-6 h-auto w-full justify-start gap-5 rounded-none border-b p-0 group-data-horizontal/tabs:h-auto"
        >
          <TabsTrigger
            value="config"
            className="h-auto flex-none rounded-none px-1 py-3 group-data-horizontal/tabs:after:bottom-0"
          >
            配置
          </TabsTrigger>
          <TabsTrigger
            value="logs"
            className="h-auto flex-none rounded-none px-1 py-3 group-data-horizontal/tabs:after:bottom-0"
          >
            日志
          </TabsTrigger>
        </TabsList>
        {!connected && (
          <Alert className="mb-4 rounded-lg" role="status">
            <InfoIcon />
            <AlertDescription>正在连接 CLI。重启期间页面会短暂断开；持续无法连接时请查看终端。</AlertDescription>
          </Alert>
        )}
        {status?.error && (
          <Alert className="mb-4 rounded-lg text-amber-700" role="status">
            <CircleAlertIcon />
            <AlertTitle>{status.fallback ? '最近一次应用失败' : '启动错误'}</AlertTitle>
            <AlertDescription className="min-w-0 text-amber-700">
              <pre className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">{status.error}</pre>
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" className="mb-4 rounded-lg">
            <CircleAlertIcon />
            <AlertDescription className="min-w-0">
              <pre className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">{error}</pre>
            </AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert className="mb-4 rounded-lg" role="status">
            <InfoIcon />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        <TabsContent value="config" className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-label="配置编辑">
          <div className="flex h-12 items-center justify-between gap-3 border-b px-4">
            <Label htmlFor="configuration">{document?.name ?? '主配置'}</Label>
            <Badge variant="secondary" className="rounded-md font-normal">
              {isDirty ? '未保存' : document?.format.toUpperCase()}
            </Badge>
          </div>
          <Textarea
            id="configuration"
            className="block h-[clamp(280px,57vh,650px)] resize-y rounded-none border-0 bg-transparent p-4 font-mono text-xs leading-7 shadow-none [field-sizing:fixed] focus-visible:ring-inset sm:p-5 md:text-[13px]"
            value={content}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={!document || Boolean(busy)}
            aria-describedby="config-help"
            onChange={(event) => {
              setContent(event.target.value);
              dirty.current = event.target.value !== documentRef.current?.content;
            }}
          />
          <div className="flex flex-col justify-end gap-3 border-t px-4 py-3.5 sm:flex-row sm:items-center sm:gap-5">
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="rounded-md"
                disabled={disabled}
                onClick={() => void loadConfig(true)}
              >
                {isDirty ? '放弃修改并重读' : '重新读取'}
              </Button>
              <Button className="rounded-md" disabled={disabled || !isDirty} onClick={() => void save()}>
                {busy === 'saving' ? (
                  <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <SaveIcon />
                )}
                {busy === 'saving' ? '正在保存…' : '保存并应用'}
              </Button>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="logs" className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-label="实时日志">
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
        </TabsContent>
      </Tabs>
    </main>
  );
}
