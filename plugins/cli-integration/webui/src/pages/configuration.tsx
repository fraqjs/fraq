import { LoaderCircleIcon, SaveIcon } from 'lucide-react';
import { lazy, Suspense } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useCliSession } from '../session';

const ConfigurationEditor = lazy(() =>
  import('@/components/configuration-editor').then((module) => ({ default: module.ConfigurationEditor })),
);

export function ConfigurationPage() {
  const { document, content, busy, disabled, isDirty, loadConfig, save, edit } = useCliSession();
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-label="配置编辑">
      <div className="flex h-12 items-center justify-between gap-3 border-b px-4">
        <Label id="configuration-label">{document?.name ?? '主配置'}</Label>
        <Badge variant="secondary" className="rounded-md font-normal">
          {isDirty ? '未保存' : document?.format.toUpperCase()}
        </Badge>
      </div>
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
          value={content}
          format={document?.format ?? 'yaml'}
          disabled={!document || Boolean(busy)}
          onChange={edit}
        />
      </Suspense>
      <div className="flex flex-col justify-end gap-3 border-t px-4 py-3.5 sm:flex-row sm:items-center sm:gap-5">
        <div className="flex gap-2">
          <Button variant="outline" className="rounded-md" disabled={disabled} onClick={() => void loadConfig(true)}>
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
    </section>
  );
}
