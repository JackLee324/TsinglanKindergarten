/**
 * server/config.ts —— 运行配置（唯一的读取入口）
 *
 * 原则：**没有默认密钥**。会话密钥/签名密钥缺失时启动就失败，
 * 而不是退化成一个"用默认密钥也能跑"的进程 —— 那种进程一旦上到公网就是公开的。
 */
export interface StorageConfig {
  readonly provider: 'local' | 's3'
  /** S3 兼容端点（R2 / S3 / MinIO 都填这里）。 */
  readonly endpoint: string
  /** R2 用 `auto`，AWS 用真实 region，MinIO 通常任意。 */
  readonly region: string
  readonly bucket: string
  readonly accessKey: string
  readonly secretKey: string
  /** MinIO 与多数自建实现需要 path-style；R2 两种都行。 */
  readonly forcePathStyle: boolean
  /** 本地驱动的根目录（仅 provider=local）。 */
  readonly localDir: string
}

export interface AppConfig {
  readonly port: number
  /**
   * 这个端口是从哪来的：`PORT`（平台注入）/ `SERVER_PORT`（我们自己配）/ `default`。
   * 只用于启动日志与排障 —— 端口来源不明时，"部署成功但访问 502"会变成猜谜。
   */
  readonly portSource: 'PORT' | 'SERVER_PORT' | 'default'
  readonly databaseUrl: string
  readonly sessionSecret: Buffer
  readonly downloadSecret: Buffer
  readonly sessionTtlSeconds: number
  readonly downloadTtlSeconds: number
  /** 上传地址有效期（写操作，短一点）。 */
  readonly storagePutTtlSeconds: number
  /** 下载/预览地址有效期。 */
  readonly storageGetTtlSeconds: number
  readonly storage: StorageConfig
  readonly isProduction: boolean
}

export const STORAGE_PROVIDER_NAMES = ['local', 's3'] as const
export type StorageProviderName = (typeof STORAGE_PROVIDER_NAMES)[number]

function readStorageConfig(isProduction: boolean): StorageConfig {
  // `STORAGE_DRIVER` 是阶段 2 的旧名字，保留兼容；新名字是 `STORAGE_PROVIDER`。
  const raw = (process.env.STORAGE_PROVIDER ?? process.env.STORAGE_DRIVER ?? 'local').trim()
  if (!STORAGE_PROVIDER_NAMES.includes(raw as StorageProviderName)) {
    throw new Error(
      `STORAGE_PROVIDER 只能是 ${STORAGE_PROVIDER_NAMES.join(' / ')}，实际是「${raw}」。`,
    )
  }
  const provider = raw as StorageProviderName

  // 业主 §3：「生产：必须 S3-compatible」。
  //
  // 这不只是风格问题：local 驱动把文件放在**应用进程所在的那台机器**上，
  // 一旦扩容/重建容器，文件就跟着没了，而且多实例之间互相看不见对方的文件。
  // 与其上线后才发现，不如启动就拒绝。
  if (isProduction && provider !== 's3') {
    throw new Error(
      '生产环境必须使用 S3 兼容对象存储（STORAGE_PROVIDER=s3）。\n' +
        '  本地文件系统只用于开发：它把文件放在应用机器上，' +
        '重建容器即丢失，且多实例之间不可见。',
    )
  }

  const forcePathStyleRaw = process.env.STORAGE_FORCE_PATH_STYLE
  return {
    provider,
    endpoint: (process.env.STORAGE_ENDPOINT ?? '').trim(),
    region: (process.env.STORAGE_REGION ?? 'auto').trim(),
    bucket: (process.env.STORAGE_BUCKET ?? '').trim(),
    accessKey: (process.env.STORAGE_ACCESS_KEY ?? '').trim(),
    secretKey: (process.env.STORAGE_SECRET_KEY ?? '').trim(),
    // 默认 true：MinIO 与多数自建实现不支持 virtual-host style，
    // 而 R2 / AWS 两条都支持，所以默认 path-style 更不容易出错。
    forcePathStyle: forcePathStyleRaw === undefined ? true : forcePathStyleRaw === '1',
    localDir: process.env.STORAGE_LOCAL_DIR ?? '.devdata/storage',
  }
}

function requireSecret(name: string, allowDevFallback: boolean, devValue: string): Buffer {
  const raw = process.env[name]
  if (!raw) {
    if (allowDevFallback) return Buffer.from(devValue, 'utf8')
    throw new Error(
      `${name} 未设置。会话/签名的安全性依赖它，必须显式提供（32 字节 base64）。`,
    )
  }
  const buf = Buffer.from(raw, 'base64')
  if (buf.length < 32) {
    throw new Error(`${name} 必须是 32 字节 base64（当前解出 ${buf.length} 字节）。`)
  }
  return buf
}

/**
 * 监听端口的解析规则（2026-10-11 修）。
 *
 * 背景（线上真实故障）：Zeabur 把服务路由到 **8080**（服务配置 `ports: [{id:web, port:8080}]`），
 * 而应用只认 `SERVER_PORT=3300` —— 容器起来了、构建也成功，但边缘连不上上游，
 * 站点一直 **502**。平台的端口是**平台决定**的（Zeabur 会注入 `PORT=${WEB_PORT}`），
 * 应用不该跟它拧着来。
 *
 * 规则（顺序固定）：
 *   1. **生产环境**跟随平台注入的 `PORT` —— PaaS 的铁律：路由到哪个端口由平台说；
 *   2. 否则用我们自己的 `SERVER_PORT`（本地开发、集成测试、演练栈都走这条，
 *      它们没有 `PORT`，行为与从前**完全一致**）；
 *   3. 都没有 → 3300（Dockerfile 的默认）。
 *
 * 为什么生产非要 PORT 优先：本机/演练栈里 `SERVER_PORT=3300` 是"我们说端口"，
 * 生产里是"平台说端口"；同一个变量在两处含义不同，就会重演这次的 502。
 * 非法值（空、非数字、越界）一律跳过，不把 `NaN` 交给 `listen()`。
 */
export function resolveServerPort(
  env: Record<string, string | undefined> = process.env,
  isProduction = false,
): { port: number; source: AppConfig['portSource'] } {
  const valid = (raw: string | undefined): number | null => {
    const text = String(raw ?? '').trim()
    if (text === '') return null
    const value = Number(text)
    if (!Number.isInteger(value) || value < 1 || value > 65535) return null
    return value
  }
  const fromPort = valid(env.PORT)
  const fromServerPort = valid(env.SERVER_PORT)
  if (isProduction && fromPort !== null) return { port: fromPort, source: 'PORT' }
  if (fromServerPort !== null) return { port: fromServerPort, source: 'SERVER_PORT' }
  if (fromPort !== null) return { port: fromPort, source: 'PORT' }
  return { port: 3300, source: 'default' }
}

export function loadConfig(): AppConfig {
  const isProduction = process.env.NODE_ENV === 'production'
  // 只有在非生产且显式允许时才用开发默认值；生产环境必须显式提供。
  const allowDevFallback = !isProduction && process.env.V2_ALLOW_DEV_SECRETS === '1'
  const resolvedPort = resolveServerPort(process.env, isProduction)
  return {
    port: resolvedPort.port,
    portSource: resolvedPort.source,
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_v2_dev',
    sessionSecret: requireSecret(
      'V2_SESSION_SECRET',
      allowDevFallback,
      'v2-dev-session-secret-not-for-production-0001',
    ),
    downloadSecret: requireSecret(
      'V2_DOWNLOAD_SECRET',
      allowDevFallback,
      'v2-dev-download-secret-not-for-production-01',
    ),
    sessionTtlSeconds: Number(process.env.V2_SESSION_TTL_SECONDS ?? 12 * 60 * 60),
    downloadTtlSeconds: Number(process.env.V2_DOWNLOAD_TTL_SECONDS ?? 300),
    storagePutTtlSeconds: Number(process.env.STORAGE_PUT_TTL_SECONDS ?? 900),
    storageGetTtlSeconds: Number(
      process.env.STORAGE_GET_TTL_SECONDS ?? process.env.V2_DOWNLOAD_TTL_SECONDS ?? 300,
    ),
    storage: readStorageConfig(isProduction),
    isProduction,
  }
}

export const SESSION_COOKIE = 'v2_session'
export const CSRF_COOKIE = 'v2_csrf'
export const CSRF_HEADER = 'x-v2-csrf'
