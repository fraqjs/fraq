import { CircleAlertIcon, InfoIcon, LoaderCircleIcon, RotateCwIcon } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import fraqLogo from '../../../../assets/brand/fraq-logo.svg';
import { useSession } from './session';

const stateNames = { starting: '正在启动', running: '运行中', restarting: '正在重启', stopped: '已停止' };

export function CliLayout() {
  const session = useSession();
  const { status, connected, busy, notice, error, disabled, restart } = session;
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
      <nav aria-label="管理功能" className="mb-6 flex gap-5 border-b">
        {[
          { to: '/config', label: '配置' },
          { to: '/logs', label: '日志' },
        ].map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                '-mb-px border-b-2 px-1 py-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                isActive
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
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
      <Outlet context={session} />
    </main>
  );
}
