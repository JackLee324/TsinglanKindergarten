/**
 * server/storage/local.provider.ts —— 本地文件系统驱动（开发用）
 * ============================================================================
 * 它**不是**假实现，而是与 S3 驱动**同等强度**的实现：
 *
 *   申请上传地址 → 浏览器 PUT → 存储层校验 sha256 与大小 → 登记时再确认对象在
 *
 * 关键在于数据面 `PUT /api/storage/local` 会**自己重算 sha256 并与令牌里的一致才写入**。
 * 令牌是 HMAC 签名的，带着 op / key / 过期时间 / **期望大小 / 期望 sha256**，
 * 客户端改不了。于是"上传的字节和声明的哈希不一致"在这里同样是硬拒绝 ——
 * 与 S3 那条 `x-amz-checksum-sha256` 已签名头的行为对齐。
 *
 * 这让测试可以在两种驱动上跑**同一组断言**：如果本地驱动只是"把字节写进去"，
 * 那么所有完整性测试就只能在 S3 上测，本地开发环境反而会漏掉这类 bug。
 */
import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { Injectable } from '@nestjs/common'
import { loadConfig } from '../config'
import {
  StorageUnavailableError,
  type ObjectStat,
  type ObjectVerification,
  type PresignGetOptions,
  type PresignedGet,
  type PresignedPut,
  type PresignPutOptions,
  type StorageHealth,
  type StorageProvider,
  StorageNotConfiguredError,
} from './storage.provider'

interface PutTokenPayload {
  readonly op: 'put'
  readonly size: number
  readonly sha256: string
}

interface GetTokenPayload {
  readonly disposition: 'inline' | 'attachment'
  readonly fileName: string
  readonly contentType: string
}

@Injectable()
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local' as const
  private readonly config = loadConfig()

  get rootDir(): string {
    return resolve(this.config.storage.localDir)
  }

  /** 防止 `../` 之类的 key 逃出存储根目录。这不是理论问题：key 来自请求。 */
  private pathFor(key: string): string {
    const root = this.rootDir
    const full = resolve(root, key)
    if (full !== root && !full.startsWith(root + sep)) {
      throw new StorageNotConfiguredError(`非法的存储 key：${key}`)
    }
    return full
  }

  // ── 预签名 ────────────────────────────────────────────────────────────────

  async presignPut(storageKey: string, options: PresignPutOptions): Promise<PresignedPut> {
    const token = this.sign(
      storageKey,
      'put',
      this.config.storagePutTtlSeconds,
      { size: options.size, sha256: options.sha256 },
    )
    return {
      storageKey,
      url: `/api/storage/local?key=${encodeURIComponent(storageKey)}&token=${token}`,
      method: 'PUT',
      // 本地驱动的数据面自己认 content-type；它不在令牌里，所以不需要客户端"必须带"。
      headers: { 'content-type': options.contentType },
      expiresInSeconds: this.config.storagePutTtlSeconds,
    }
  }

  /**
   * 生成下载/预览地址。
   *
   * ⚠️ `disposition` / 文件名 / Content-Type 都被**签进令牌**，URL 里只剩 key + token。
   *
   * 第一版把它们放在查询参数里，而签名只覆盖 (op, key, exp) —— 于是任何人
   * 在地址后面追加 `&type=text/html` 就能改掉响应的 Content-Type，
   * `&name=evil.exe` 就能改掉下载文件名（Content-Disposition 注入）。
   * 这个洞是集成测试发现的（"数据库里的 mime 决定响应类型"那一组）。
   *
   * 客户端能改的一切都不该参与"服务端决定什么"，所以这三个值只出现在签名里。
   */
  async presignGet(storageKey: string, options: PresignGetOptions): Promise<PresignedGet> {
    const token = this.sign(storageKey, 'get', this.config.storageGetTtlSeconds, {
      d: options.disposition,
      n: options.fileName,
      t: options.contentType,
    })
    return {
      url: `/api/storage/local?key=${encodeURIComponent(storageKey)}&token=${token}`,
      expiresInSeconds: this.config.storageGetTtlSeconds,
    }
  }

  // ── 读取与校验 ────────────────────────────────────────────────────────────

  async head(storageKey: string): Promise<ObjectStat | null> {
    const path = this.pathFor(storageKey)
    if (!existsSync(path) || !statSync(path).isFile()) return null
    const buf = readFileSync(path)
    return {
      key: storageKey,
      size: buf.byteLength,
      contentType: this.contentTypeOf(path),
      sha256: sha256Hex(buf),
      etag: null,
      createdAt: this.createdAtOf(path),
    }
  }

  /**
   * 本地驱动能直接读到磁盘，所以用**最强**的方式校验：把对象读回来自己算 sha256。
   * 不占用任何网络流量（同一个进程同一块盘）。
   */
  async verify(
    storageKey: string,
    expected: { size: number; sha256: string },
  ): Promise<ObjectVerification> {
    const stat = await this.head(storageKey)
    if (stat === null) return { ok: false, method: 'read-back', reason: 'NOT_FOUND' }
    if (stat.size !== expected.size) {
      return {
        ok: false,
        method: 'read-back',
        reason: 'SIZE_MISMATCH',
        detail: `实际 ${stat.size} 字节，声明 ${expected.size} 字节`,
      }
    }
    if (stat.sha256 !== expected.sha256.toLowerCase()) {
      return {
        ok: false,
        method: 'read-back',
        reason: 'HASH_MISMATCH',
        detail: `实际 ${stat.sha256}，声明 ${expected.sha256.toLowerCase()}`,
      }
    }
    return { ok: true, method: 'read-back' }
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFileSync(this.pathFor(storageKey))
  }

  /** 本地驱动：读前 N 字节。同一个进程同一块盘，直接切。 */
  async readRange(storageKey: string, bytes: number): Promise<Buffer> {
    const buf = readFileSync(this.pathFor(storageKey))
    return buf.subarray(0, Math.max(0, bytes))
  }

  /** 写入对象。**只在数据面校验通过后调用**（见 StorageController）。 */
  write(storageKey: string, body: Buffer, contentType: string): void {
    const path = this.pathFor(storageKey)
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
      writeFileSync(`${path}.meta.json`, JSON.stringify({ contentType }))
    } catch (error) {
      throw asStorageUnavailable(error, '写入')
    }
  }

  async delete(storageKey: string): Promise<void> {
    const path = this.pathFor(storageKey)
    try {
      rmSync(path, { force: true })
      rmSync(`${path}.meta.json`, { force: true })
    } catch (error) {
      // 删不掉（目录只读 / 磁盘错误）时**必须抛错**，不能假装删成功：
      // FilesService.remove 依赖它来决定"数据库那一行还删不删"（§17）。
      throw asStorageUnavailable(error, '删除')
    }
  }

  async list(prefix: string): Promise<string[]> {
    const root = this.rootDir
    const base = resolve(root, prefix)
    if (!base.startsWith(root)) return []
    if (!existsSync(base)) return []
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (!entry.name.endsWith('.meta.json')) out.push(full.slice(root.length + 1))
      }
    }
    walk(base)
    return out
  }

  async health(): Promise<StorageHealth> {
    const dir = this.rootDir
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '.healthcheck'), 'ok')
      rmSync(join(dir, '.healthcheck'), { force: true })
      return {
        provider: 'local',
        configured: true,
        reachable: true,
        detail: `本地目录可读写：${dir}`,
      }
    } catch (error) {
      return {
        provider: 'local',
        configured: true,
        reachable: false,
        detail: `本地目录不可写：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // ── 令牌 ──────────────────────────────────────────────────────────────────

  /** 校验上传令牌，并**返回令牌里锁定的期望值**（客户端无法篡改）。 */
  verifyPutToken(storageKey: string, token: string): PutTokenPayload | null {
    const claimed = this.verifyToken(storageKey, 'put', token)
    if (claimed === null) return null
    const size = Number(claimed.size)
    if (!Number.isFinite(size) || size <= 0) return null
    if (typeof claimed.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(claimed.sha256)) return null
    return { op: 'put', size, sha256: claimed.sha256 }
  }

  /** 校验下载令牌，并返回**令牌里锁定的**处置方式 / 文件名 / 类型。 */
  verifyGetToken(storageKey: string, token: string): GetTokenPayload | null {
    const claimed = this.verifyToken(storageKey, 'get', token)
    if (claimed === null) return null
    const disposition = claimed.d === 'attachment' ? 'attachment' : 'inline'
    const fileName = typeof claimed.n === 'string' && claimed.n !== '' ? claimed.n : 'download'
    const contentType =
      typeof claimed.t === 'string' && claimed.t !== ''
        ? claimed.t
        : 'application/octet-stream'
    return { disposition, fileName, contentType }
  }

  /**
   * 令牌 = `exp.extraJson.base64url(HMAC(op:key:exp:extra))`。
   *
   * `extra` 参与签名，所以期望大小与期望 sha256 都是**不可篡改**的。
   */
  private sign(
    key: string,
    op: string,
    ttlSeconds: number,
    extra: Record<string, unknown> = {},
  ): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds
    const extraJson = Buffer.from(JSON.stringify(extra)).toString('base64url')
    const mac = this.mac(op, key, exp, extraJson)
    return `${exp}.${extraJson}.${mac}`
  }

  /**
   * 校验 HMAC 令牌。
   *
   * ⚠️ 名字是 `verifyToken`，不是 `verify` —— 后者已经是 StorageProvider 接口里
   * "校验对象内容"的那个方法。同名会编译不过（第一次就是这么被编译器拦下的）。
   */
  private verifyToken(
    key: string,
    op: string,
    token: string,
  ): Record<string, unknown> | null {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [expRaw, extraJson, mac] = parts
    const exp = Number(expRaw)
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null
    const expected = this.mac(op, key, exp, extraJson)
    const a = Buffer.from(mac)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    try {
      return JSON.parse(Buffer.from(extraJson, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >
    } catch {
      return null
    }
  }

  private mac(op: string, key: string, exp: number, extraJson: string): string {
    return createHmac('sha256', this.config.downloadSecret)
      .update(`${op}:${key}:${exp}:${extraJson}`)
      .digest('base64url')
  }

  /**
   * 对象的创建时间。
   *
   * 用 `birthtime`（文件真正的创建时间），拿不到时退到 `mtime`。
   * 不用 `ctime`：它是 inode 变更时间，chmod 一下就会变，
   * 而清理脚本要判断的是"这个对象躺了多久"。
   */
  private createdAtOf(path: string): Date | null {
    try {
      const stat = statSync(path)
      const time = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
      return new Date(time)
    } catch {
      return null
    }
  }

  private contentTypeOf(path: string): string {
    const metaPath = `${path}.meta.json`
    if (!existsSync(metaPath)) return 'application/octet-stream'
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { contentType?: string }
      return meta.contentType ?? 'application/octet-stream'
    } catch {
      return 'application/octet-stream'
    }
  }
}

/**
 * 文件系统错误 → `StorageUnavailableError`。
 *
 * WHY：磁盘满 / 目录只读 / 权限不对，这些都是**存储不可用**，不是"服务端代码崩了"。
 * 让它们变成裸 Error 的话 Nest 会回 500，前端只能显示"服务器内部错误"，
 * 而运维要从日志里猜。映射成 503 + STORAGE_UNAVAILABLE 之后，
 * 界面能说"文件存储服务暂时不可用，请稍后重试"，也符合 §20 的错误码约定。
 */
function asStorageUnavailable(error: unknown, action: string): StorageUnavailableError {
  if (error instanceof StorageNotConfiguredError) return error as unknown as StorageUnavailableError
  const code = (error as { code?: string })?.code ?? 'UNKNOWN'
  const message = error instanceof Error ? error.message : String(error)
  return new StorageUnavailableError(`${action}本地文件失败（${code}）：${message}`, error)
}

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

export function newStorageKey(resourceId: string, fileNameSegment: string): string {
  return `resources/${resourceId}/${randomUUID()}-${fileNameSegment}`
}

/**
 * 存储 key 的合法形状：`resources/{resourceId}/{uuid}-{safeName}`。
 *
 * ⚠️ 这一条**不是**可选的写法偏好：key 直接决定对象在桶里的位置，
 * 形状固定才能保证 (1) 每个资源一个前缀，便于清理；
 * (2) 用户文件名不参与目录结构，`../` 无从穿越。
 */
export const STORAGE_KEY_PATTERN =
  /^resources\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[\w.\-\u4e00-\u9fa5]+$/

export function isValidStorageKey(key: unknown): key is string {
  return typeof key === 'string' && STORAGE_KEY_PATTERN.test(key)
}

/** key 是否属于某个资源（登记时防止把别人的对象挂到自己名下）。 */
export function storageKeyBelongsTo(storageKey: string, resourceId: string): boolean {
  return isValidStorageKey(storageKey) && storageKey.startsWith(`resources/${resourceId}/`)
}
