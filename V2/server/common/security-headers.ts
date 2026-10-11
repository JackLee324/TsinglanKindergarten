/**
 * server/common/security-headers.ts —— 安全响应头**由应用自己出**
 * ============================================================================
 * 为什么这件事必须在应用里做（2026-10-11 实测发现）：
 *
 *   这六个头以前**只**由演练栈里的 Nginx 加（`deploy/nginx.conf.template`）。
 *   而 Zeabur 上是"容器直接对外"，没有 Nginx —— 于是部署到正式环境后
 *   HSTS / CSP / X-Content-Type-Options / Referrer-Policy / X-Frame-Options /
 *   Permissions-Policy **一个都没有**，项目自己的部署自检
 *   `deploy/verify.mjs` 第 4 项必然失败（实测：本机以生产配置起进程，首页只有
 *   `Content-Type`）。
 *
 *   反向代理在不在，取决于平台 —— 安全头不该取决于平台。所以搬进应用：
 *   无论前面是 Nginx、Zeabur 网关还是直连，这六个头都在。
 *
 * Nginx 那边**同步删掉了**重复的 add_header（单一真相）：CSP 这种头重复出现时
 * 浏览器取**交集**，两处维护迟早会打架（例如一边放行了对象存储、另一边没放行，
 * 表现为"图片突然加载不出来"）。
 *
 * 内容与原来 Nginx 里的策略**逐条一致**，只把 `${STORAGE_ORIGIN}` 换成
 * 应用自己的 `STORAGE_ENDPOINT` 的 origin —— 浏览器直传上传就是打到那个域名的，
 * 不放行就等于生产环境上传必失败。
 */
import type { RequestHandler } from 'express'

/** 从配置里的存储端点取出浏览器会访问的 origin（`https://host[:port]`）。 */
export function securityOriginOf(endpoint: string): string | null {
  const raw = String(endpoint ?? '').trim()
  if (raw === '') return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.host === '') return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/**
 * CSP：脚本/样式只允许同源；预览要嵌对象存储的 PDF、显示它的图片，
 * 并且**浏览器直传 PUT 是打到对象存储的**（connect-src），所以要放行存储 origin。
 *
 * 不放行 `unsafe-inline` 的 script：Vite 产物是外链文件，`index.html` 里没有内联脚本
 * （已核对构建产物）。`style` 允许 inline 是因为 React 组件的 style 属性
 * （进度条宽度之类）会生成内联样式。
 */
export function buildContentSecurityPolicy(storageOrigin: string | null): string {
  const storage = storageOrigin === null ? '' : ` ${storageOrigin}`
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${storage}`,
    `frame-src 'self'${storage}`,
    `connect-src 'self'${storage}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ')
}

export function buildSecurityHeaders(storageOrigin: string | null): Record<string, string> {
  return {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Security-Policy': buildContentSecurityPolicy(storageOrigin),
  }
}

/**
 * 给每个响应加头。
 *
 * 已经设过的头不覆盖：存储下载那条路由会自己设 `X-Content-Type-Options`
 * （见 `storage.controller.ts`），语义相同，没必要互相覆盖。
 */
export function securityHeadersMiddleware(storageOrigin: string | null): RequestHandler {
  const headers = buildSecurityHeaders(storageOrigin)
  return (_req, res, next) => {
    for (const [name, value] of Object.entries(headers)) {
      if (!res.hasHeader(name)) res.setHeader(name, value)
    }
    next()
  }
}
