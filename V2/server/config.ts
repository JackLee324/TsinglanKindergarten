/**
 * server/config.ts —— 运行配置（唯一的读取入口）
 *
 * 原则：**没有默认密钥**。会话密钥/签名密钥缺失时启动就失败，
 * 而不是退化成一个"用默认密钥也能跑"的进程 —— 那种进程一旦上到公网就是公开的。
 */
export interface AppConfig {
  readonly port: number
  readonly databaseUrl: string
  readonly sessionSecret: Buffer
  readonly downloadSecret: Buffer
  readonly sessionTtlSeconds: number
  readonly downloadTtlSeconds: number
  readonly storageDriver: 'local' | 's3'
  readonly storageLocalDir: string
  readonly isProduction: boolean
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

export function loadConfig(): AppConfig {
  const isProduction = process.env.NODE_ENV === 'production'
  // 只有在非生产且显式允许时才用开发默认值；生产环境必须显式提供。
  const allowDevFallback = !isProduction && process.env.V2_ALLOW_DEV_SECRETS === '1'
  return {
    port: Number(process.env.SERVER_PORT ?? 3300),
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
    storageDriver: process.env.STORAGE_DRIVER === 's3' ? 's3' : 'local',
    storageLocalDir: process.env.STORAGE_LOCAL_DIR ?? '.devdata/storage',
    isProduction,
  }
}

export const SESSION_COOKIE = 'v2_session'
export const CSRF_COOKIE = 'v2_csrf'
export const CSRF_HEADER = 'x-v2-csrf'
