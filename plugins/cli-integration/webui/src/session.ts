import type { AppStatus, ConfigWorkspace, LogCursor, LogEntry } from '@fraqjs/cli-protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';

import { api } from './client';

export function useSession() {
  const [status, setStatus] = useState<AppStatus>();
  const [connected, setConnected] = useState(false);
  const [workspace, setWorkspace] = useState<ConfigWorkspace>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedFileId, selectFile] = useState<string>();
  const [busy, setBusy] = useState<'saving' | 'restarting' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [gap, setGap] = useState(false);
  const [following, setFollowing] = useState(true);
  const draftsRef = useRef<Record<string, string>>({});
  const cursor = useRef<LogCursor>({});
  const logScrollTop = useRef(0);
  const restartGeneration = useRef<number | undefined>(undefined);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadConfig = useCallback(async (discard = false) => {
    try {
      const next = await api<ConfigWorkspace>('/config/files');
      if (Object.keys(draftsRef.current).length && !discard) return;
      setWorkspace(next);
      draftsRef.current = {};
      setDrafts({});
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
    if (!workspace) return;
    setBusy('saving');
    setError('');
    setNotice('');
    try {
      const saved = await api<ConfigWorkspace>('/config/files', {
        method: 'PUT',
        body: JSON.stringify({
          revision: workspace.revision,
          files: Object.entries(draftsRef.current).map(([id, content]) => ({ id, content })),
        }),
      });
      setWorkspace(saved);
      draftsRef.current = {};
      setDrafts({});
      setNotice('配置文件已保存。应用结果见运行状态和日志。');
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
  const document = workspace?.files.find((file) => file.id === selectedFileId) ?? workspace?.files[0];
  const content = document?.editable ? (drafts[document.id] ?? document.content) : '';
  const isDirty = Object.keys(drafts).length > 0;

  const edit = (value: string) => {
    if (!document?.editable) return;
    const next = { ...draftsRef.current };
    if (value === document.content) delete next[document.id];
    else next[document.id] = value;
    draftsRef.current = next;
    setDrafts(next);
  };

  return {
    status,
    connected,
    workspace,
    drafts,
    selectFile,
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
