import type { AppStatus, ConfigDocument, LogCursor, LogEntry } from '@fraqjs/cli-protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';

import { api } from './client';

export function useSession() {
  const [status, setStatus] = useState<AppStatus>();
  const [connected, setConnected] = useState(false);
  const [document, setDocument] = useState<ConfigDocument>();
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState<'saving' | 'restarting' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [gap, setGap] = useState(false);
  const [following, setFollowing] = useState(true);
  const dirty = useRef(false);
  const documentRef = useRef<ConfigDocument | undefined>(undefined);
  const cursor = useRef<LogCursor>({});
  const logScrollTop = useRef(0);
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

  const edit = (value: string) => {
    setContent(value);
    dirty.current = value !== documentRef.current?.content;
  };

  return {
    status,
    connected,
    document,
    content,
    busy,
    notice,
    error,
    disabled,
    isDirty,
    loadConfig,
    save,
    restart,
    edit,
    logs,
    setLogs,
    gap,
    setGap,
    following,
    setFollowing,
    cursor,
    logScrollTop,
  };
}

export function useCliSession() {
  return useOutletContext<ReturnType<typeof useSession>>();
}
