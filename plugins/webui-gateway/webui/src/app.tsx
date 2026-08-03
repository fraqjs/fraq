import {
  ArrowRightIcon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  LogOutIcon,
  PanelsTopLeftIcon,
  RotateCwIcon,
} from 'lucide-react';
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const gatewayBasePath = '/webui';
const loginPath = `${gatewayBasePath}/login`;
const isGatewayIndex =
  window.location.pathname === gatewayBasePath || window.location.pathname === `${gatewayBasePath}/`;
const params = new URLSearchParams(window.location.search);
const returnTo = resolveReturnTo(params.get('returnTo'));

interface SessionResponse {
  authenticated?: boolean;
  webuis?: unknown;
}

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
      url.pathname === loginPath ||
      url.pathname.startsWith(`${loginPath}/`) ||
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

async function requestSession(signal?: AbortSignal): Promise<SessionResponse> {
  const response = await fetch(`${gatewayBasePath}/auth/session`, {
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) {
    throw new Error('session request failed');
  }
  return response.json() as Promise<SessionResponse>;
}

export function App() {
  useEffect(() => {
    document.title = isGatewayIndex ? 'Fraq WebUI' : '登录到 Fraq';
  }, []);

  return isGatewayIndex ? <WebuiIndex /> : <Login />;
}

function WebuiIndex() {
  const [webuis, setWebuis] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    requestSession(controller.signal)
      .then((session) => {
        if (!session.authenticated) {
          window.location.replace(`${loginPath}/`);
          return;
        }
        setWebuis(
          Array.isArray(session.webuis) ? session.webuis.filter((id): id is string => typeof id === 'string') : [],
        );
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') {
          return;
        }
        setError('暂时无法加载 WebUI，请稍后重试。');
      });
    return () => controller.abort();
  }, []);

  async function logout() {
    if (loggingOut) {
      return;
    }
    setError(undefined);
    setLoggingOut(true);
    try {
      const response = await fetch(`${gatewayBasePath}/auth/logout`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error('logout request failed');
      }
      window.location.replace(`${loginPath}/`);
    } catch {
      setError('暂时无法退出登录，请稍后重试。');
      setLoggingOut(false);
    }
  }

  return (
    <div className="min-h-dvh bg-white text-[#171717]">
      <header className="border-b border-[#eaeaea]">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-5 sm:px-6">
          <span className="text-sm font-semibold">Fraq</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 rounded-md text-[#666666] hover:bg-[#f5f5f5] hover:text-[#171717]"
            disabled={loggingOut}
            onClick={logout}
            title="退出登录"
            aria-label="退出登录"
          >
            {loggingOut ? (
              <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogOutIcon className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-6 sm:py-14" aria-labelledby="webui-title">
        <h1 id="webui-title" className="text-2xl font-semibold">
          WebUI
        </h1>

        {error ? (
          <Alert variant="destructive" className="mt-6 rounded-md border-[#f1aeb1] bg-[#fff8f8] px-3.5 py-3">
            <CircleAlertIcon className="size-4" aria-hidden="true" />
            <AlertDescription className="flex min-w-0 items-center justify-between gap-3 text-[#b4232a]">
              <span>{error}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0 rounded-md text-[#b4232a] hover:bg-[#fce8e9] hover:text-[#8f1d22]"
                onClick={() => window.location.reload()}
              >
                <RotateCwIcon className="size-3.5" aria-hidden="true" />
                重试
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {webuis === undefined ? (
          error ? null : (
            <div className="flex h-40 items-center justify-center" aria-label="正在加载 WebUI">
              <LoaderCircleIcon className="size-5 animate-spin text-[#737373]" aria-hidden="true" />
            </div>
          )
        ) : webuis.length === 0 ? (
          <div className="mt-6 border-t border-[#eaeaea] py-12 text-center">
            <p className="text-sm font-medium">暂无可用 WebUI</p>
            <p className="mt-1 text-sm text-[#737373]">挂载后会显示在这里。</p>
          </div>
        ) : (
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">
            {webuis.map((id) => (
              <li key={id}>
                <a
                  href={`${gatewayBasePath}/${id}/`}
                  className="group flex min-h-20 items-center gap-3 rounded-md border border-[#e5e5e5] px-4 py-3 transition-colors hover:border-[#a3a3a3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/25"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-[#e5e5e5] bg-[#fafafa] text-[#525252]">
                    <PanelsTopLeftIcon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-sm font-medium">{id}</span>
                  <ArrowRightIcon
                    className="size-4 shrink-0 text-[#a3a3a3] transition-transform group-hover:translate-x-0.5 group-hover:text-[#525252]"
                    aria-hidden="true"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function Login() {
  const [accessToken, setAccessToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<'checking' | 'idle' | 'submitting'>('checking');
  const [error, setError] = useState<string>();
  const accessTokenInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestSession(controller.signal)
      .then((session) => {
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
