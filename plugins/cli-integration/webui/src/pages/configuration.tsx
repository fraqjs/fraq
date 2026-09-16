import { LoaderCircleIcon, SaveIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCliSession } from '../session';

export function ConfigurationPage() {
  const { document, content, busy, disabled, isDirty, loadConfig, save, edit } = useCliSession();
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-label="配置编辑">
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
        onChange={(event) => edit(event.target.value)}
      />
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
