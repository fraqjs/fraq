import { ArrowRightIcon, CircleAlertIcon, EyeIcon, EyeOffIcon, LoaderCircleIcon } from 'lucide-react';
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const params = new URLSearchParams(window.location.search);
const gatewayBasePath = '/webui';
const returnTo = resolveReturnTo(params.get('returnTo'));

function resolveReturnTo(value: string | null): string {
  const fallback = `${gatewayBasePath}/`;
  if (!value?.startsWith('/')) {
    return fallback;
  }
  try {
    const url = new URL(value, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      (url.pathname !== gatewayBasePath && !url.pathname.startsWith(`${gatewayBasePath}/`)) ||
      url.pathname === `${gatewayBasePath}/login` ||
      url.pathname.startsWith(`${gatewayBasePath}/login/`) ||
      url.pathname === `${gatewayBasePath}/auth` ||
      url.pathname.startsWith(`${gatewayBasePath}/auth/`)
    ) {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function App() {
  const [accessToken, setAccessToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<'checking' | 'idle' | 'submitting'>('checking');
  const [error, setError] = useState<string>();
  const accessTokenInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${gatewayBasePath}/auth/session`, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('session request failed');
        }
        const session = (await response.json()) as { authenticated?: boolean };
        if (session.authenticated) {
          window.location.replace(returnTo);
          return;
        }
        setStatus('idle');
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') {
          return;
        }
        setStatus('idle');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (status === 'idle') {
      accessTokenInput.current?.focus();
    }
  }, [status]);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || status === 'submitting') {
      return;
    }

    setError(undefined);
    setStatus('submitting');
    try {
      const response = await fetch(`${gatewayBasePath}/auth/login`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, returnTo }),
      });
      if (!response.ok) {
        setError(response.status === 401 ? '访问令牌不正确，请重新输入。' : '暂时无法完成登录，请稍后重试。');
        setStatus('idle');
        return;
      }
      const result = (await response.json()) as { redirectTo: string };
      window.location.assign(result.redirectTo);
    } catch {
      setError('无法连接到 Fraq 服务，请检查网络后重试。');
      setStatus('idle');
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-white px-6 py-12 text-[#171717]">
      <section className="w-full max-w-[22.5rem]" aria-labelledby="login-title">
        <h1 id="login-title" className="mb-8 text-center text-xl font-semibold text-[#171717]">
          登录 Fraq WebUI
        </h1>

        <form className="space-y-5" onSubmit={submit}>
          <div className="space-y-2.5">
            <Label htmlFor="access-token" className="text-sm font-medium text-[#171717]">
              访问令牌
            </Label>
            <div className="relative">
              <Input
                ref={accessTokenInput}
                id="access-token"
                autoComplete="current-password"
                disabled={status !== 'idle'}
                type={showToken ? 'text' : 'password'}
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                aria-invalid={Boolean(error)}
                className="h-11 rounded-md border border-[#d4d4d4] bg-white px-3 pr-11 font-mono text-sm text-[#171717] transition-colors duration-150 focus-visible:border-[#171717] focus-visible:ring-1 focus-visible:ring-[#171717] aria-invalid:border-[#e5484d] aria-invalid:ring-1 aria-invalid:ring-[#e5484d]"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0.5 top-0.5 size-10 rounded-md text-[#737373] transition-colors duration-150 hover:bg-[#f5f5f5] hover:text-[#171717] focus-visible:border-transparent focus-visible:ring-1 focus-visible:ring-[#171717]"
                disabled={status !== 'idle'}
                onClick={() => setShowToken((visible) => !visible)}
                title={showToken ? '隐藏访问令牌' : '显示访问令牌'}
                aria-label={showToken ? '隐藏访问令牌' : '显示访问令牌'}
              >
                {showToken ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
              </Button>
            </div>
          </div>

          {error ? (
            <Alert variant="destructive" className="rounded-md border-[#f1aeb1] bg-[#fff8f8] px-3.5 py-3">
              <CircleAlertIcon className="size-4" aria-hidden="true" />
              <AlertDescription className="text-[#b4232a]">{error}</AlertDescription>
            </Alert>
          ) : null}

          <Button
            className="h-11 w-full rounded-md border border-[#171717] bg-[#171717] text-sm font-medium text-white transition-colors duration-150 hover:border-[#333333] hover:bg-[#333333] focus-visible:border-[#171717] focus-visible:ring-2 focus-visible:ring-[#171717]/25 disabled:border-[#e5e5e5] disabled:bg-[#e5e5e5] disabled:text-[#a3a3a3] disabled:opacity-100"
            type="submit"
            disabled={!accessToken || status !== 'idle'}
          >
            {status !== 'idle' ? (
              <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <ArrowRightIcon className="size-4" data-icon="inline-start" aria-hidden="true" />
            )}
            {status === 'checking' ? '检查会话' : status === 'submitting' ? '正在验证' : '继续'}
          </Button>
        </form>
      </section>
    </main>
  );
}
