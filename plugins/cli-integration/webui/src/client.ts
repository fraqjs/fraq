export const base = '/webui/cli-integration';
export function login() {
  window.location.assign(
    `/webui/login/?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}${window.location.hash}`)}`,
  );
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
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
