import { CircleAlertIcon, FileIcon, LoaderCircleIcon, LockKeyholeIcon, SaveIcon } from 'lucide-react';
import { lazy, Suspense } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useCliSession } from '../session';

const ConfigurationEditor = lazy(() =>
  import('@/components/configuration-editor').then((module) => ({ default: module.ConfigurationEditor })),
);

export function ConfigurationPage() {
  const { workspace, drafts, selectFile, document, content, busy, disabled, isDirty, loadConfig, save, edit } =
    useCliSession();
  const dirtyCount = Object.keys(drafts).length;
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-label="配置编辑">
      <div className="grid min-w-0 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="min-w-0 border-b md:border-r md:border-b-0">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-medium">配置文件</h2>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={workspace?.root}>
              {workspace?.root ?? '正在读取…'}
            </p>
          </div>
          <nav className="max-h-40 space-y-1 overflow-auto p-2 md:max-h-[65vh]" aria-label="配置文件">
            {workspace?.files.map((file) => (
              <Button
                key={file.id}
                variant="ghost"
                className={cn(
                  'h-auto min-h-9 w-full justify-start rounded-md px-2 py-2 text-left font-normal whitespace-normal',
                  document?.id === file.id && 'bg-muted',
                )}
                aria-pressed={document?.id === file.id}
                onClick={() => selectFile(file.id)}
                title={file.name}
              >
                {file.editable ? <FileIcon /> : <LockKeyholeIcon />}
                <span className="min-w-0 flex-1 break-all">{file.name}</span>
                {drafts[file.id] !== undefined && (
                  <span className="size-1.5 shrink-0 rounded-full bg-foreground" aria-label="未保存" />
                )}
              </Button>
            ))}
          </nav>
        </aside>
        <div className="min-w-0">
          <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
            <Label id="configuration-label" className="min-w-0 break-all">
              {document?.name ?? '主配置'}
            </Label>
            <Badge variant="secondary" className="shrink-0 rounded-md font-normal">
              {document && drafts[document.id] !== undefined
                ? '未保存'
                : document?.editable
                  ? document.format.toUpperCase()
                  : '只读'}
            </Badge>
          </div>
          {workspace?.error && (
            <Alert className="rounded-none border-x-0 border-t-0 text-amber-700" role="status">
              <CircleAlertIcon />
              <AlertDescription className="text-amber-700">{workspace.error}</AlertDescription>
            </Alert>
          )}
          {document?.editable ? (
            <Suspense
              fallback={
                <div
                  className="flex h-[clamp(280px,57vh,650px)] items-center justify-center text-sm text-muted-foreground"
                  role="status"
                >
                  正在加载编辑器…
                </div>
              }
            >
              <ConfigurationEditor
                key={document.id}
                value={content}
                format={document.format}
                disabled={Boolean(busy)}
                onChange={edit}
              />
            </Suspense>
          ) : (
            <div
              className="flex h-[clamp(280px,57vh,650px)] items-center justify-center gap-2 px-4 text-sm text-muted-foreground"
              role="status"
            >
              {document && <LockKeyholeIcon className="size-4 shrink-0" />}
              {document && !document.editable ? document.reason : '正在读取配置…'}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3.5">
        <span className="text-xs text-muted-foreground">
          {dirtyCount ? `${dirtyCount} 个文件未保存` : `${workspace?.files.length ?? 0} 个文件`}
        </span>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="rounded-md" disabled={disabled} onClick={() => void loadConfig(true)}>
            {isDirty ? '放弃全部修改并重读' : '重新读取'}
          </Button>
          <Button className="rounded-md" disabled={disabled || !isDirty} onClick={() => void save()}>
            {busy === 'saving' ? (
              <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
            ) : (
              <SaveIcon />
            )}
            {busy === 'saving' ? '正在保存…' : '保存全部并应用'}
          </Button>
        </div>
      </div>
    </section>
  );
}
