/**
 * client/src/api/http.ts —— 前端**唯一**的 HTTP 出口
 * ============================================================================
 * 所有请求都经过这里。页面与组件不允许直接 `fetch`。
 *
 * 它负责三件前端不该重复实现的事：
 *   1. 带上 cookie（`credentials: 'include'`）；
 *   2. 状态改变的方法自动附上 CSRF 头（值取自非 HttpOnly 的 `v2_csrf` cookie）——
 *      V1 的经验是"每个调用点手写一次"必然写漏，而写漏的表现是随机 403；
 *   3. 把服务端的 `{ statusCode, code, message }` 统一成一个 `ApiError`，
 *      页面据此显示**可读的中文**，而不是"请求失败"。
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function readCookie(name: string): string | null {
  const target = `${name}=`
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(target)) return decodeURIComponent(trimmed.slice(target.length))
  }
  return null
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly body?: unknown
  /** 401 时不要自动跳登录页（例如启动时的"我是谁"探测）。 */
  readonly skipAuthRedirect?: boolean
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') {
    const csrf = readCookie('v2_csrf')
    if (csrf) headers['x-v2-csrf'] = csrf
  }

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  if (res.status === 204) return undefined as T

  const text = await res.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  if (!res.ok) {
    const body = (payload ?? {}) as Record<string, unknown>
    throw new ApiError(
      res.status,
      typeof body.code === 'string' ? body.code : 'ERROR',
      typeof body.message === 'string' ? body.message : `请求失败（HTTP ${res.status}）`,
    )
  }
  return payload as T
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
