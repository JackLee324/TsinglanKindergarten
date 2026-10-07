import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, existsSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { Injectable } from '@nestjs/common'
import { loadConfig } from '../config'

export interface PresignedPut {
  readonly storageKey: string
  readonly url: string
  readonly method: 'PUT'
  readonly headers: Record<string, string>
}

export interface ObjectHead {
  readonly key: string
  readonly size: number
  readonly contentType: string
  readonly sha256: string
}

/**
 * StorageService —— 对象存储适配器
 * ============================================================================
 * 阶段 2 只实现 **local**（文件系统）驱动。它**不是**假实现：
 *
 *   申请上传地址 → 浏览器 PUT 到那个地址 → 服务端真的去读回对象、算 sha256、
 *   与客户端声明比对 → 通过才登记 resource_files
 *
 * 这条链路与 S3/R2 的 presigned URL 形状完全一致（URL + method + headers），
 * 所以阶段 6 接 R2 时只是换一个 adapter，**不换调用方，也不换测试的断言**。
 *
 * 为什么一定要 `head()`：V1 出现过"数据库说文件存在、对象存储里却没有"的假成功。
 * 登记文件之前必须真的能读到对象，否则拒绝登记。
 */
@Injectable()
export class StorageService {
  private readonly config = loadConfig()

  private root(): string {
    return resolve(this.config.storageLocalDir)
  }

  /** 防止 `../` 之类的 key 逃出存储根目录。这不是理论问题：key 来自请求。 */
  private pathFor(key: string): string {
    const root = this.root()
    const full = resolve(root, key)
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`非法的存储 key：${key}`)
    }
    return full
  }

  newKey(directoryId: string, resourceId: string, fileName: string): string {
    const safe = fileName
      .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
      .slice(-80)
    return `${directoryId}/${resourceId}/${randomUUID()}-${safe}`
  }

  presignPut(key: string): PresignedPut {
    const token = this.sign(key, 'put', 900)
    return {
      storageKey: key,
      url: `/api/storage/local?key=${encodeURIComponent(key)}&token=${token}`,
      method: 'PUT',
      headers: {},
    }
  }

  presignGet(key: string, disposition: 'inline' | 'attachment', fileName: string): string {
    const token = this.sign(key, 'get', this.config.downloadTtlSeconds)
    const params = new URLSearchParams({ key, token, disposition, name: fileName })
    return `/api/storage/local?${params.toString()}`
  }

  /** 真正把对象读出来校验（大小 + sha256 + 内容类型）。 */
  head(key: string): ObjectHead | null {
    const path = this.pathFor(key)
    const metaPath = `${path}.meta.json`
    if (!existsSync(path) || !statSync(path).isFile()) return null
    const buf = readFileSync(path)
    const meta = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { contentType?: string })
      : {}
    return {
      key,
      size: buf.byteLength,
      contentType: meta.contentType ?? 'application/octet-stream',
      sha256: createHash('sha256').update(buf).digest('hex'),
    }
  }

  read(key: string): Buffer {
    return readFileSync(this.pathFor(key))
  }

  write(key: string, body: Buffer, contentType: string): void {
    const path = this.pathFor(key)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    writeFileSync(`${path}.meta.json`, JSON.stringify({ contentType }))
  }

  delete(key: string): void {
    const path = this.pathFor(key)
    rmSync(path, { force: true })
    rmSync(`${path}.meta.json`, { force: true })
  }

  verifyPutToken(key: string, token: string): boolean {
    return this.verify(key, 'put', token)
  }

  verifyGetToken(key: string, token: string): boolean {
    return this.verify(key, 'get', token)
  }

  private sign(key: string, op: string, ttlSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds
    const payload = `${op}:${key}:${exp}`
    const mac = createHmac('sha256', this.config.downloadSecret).update(payload).digest('base64url')
    return `${exp}.${mac}`
  }

  private verify(key: string, op: string, token: string): boolean {
    const [expRaw, mac] = token.split('.')
    const exp = Number(expRaw)
    if (!Number.isFinite(exp) || !mac) return false
    if (exp * 1000 < Date.now()) return false
    const expected = createHmac('sha256', this.config.downloadSecret)
      .update(`${op}:${key}:${exp}`)
      .digest('base64url')
    const a = Buffer.from(mac)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }
}

/** 存储 key 的合法形状（登记时校验，防止把任意路径写进数据库）。 */
export const STORAGE_KEY_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[\w.\-\u4e00-\u9fa5]+$/

export function isValidStorageKey(key: unknown): key is string {
  return typeof key === 'string' && STORAGE_KEY_PATTERN.test(key)
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export const __internal = { join }
