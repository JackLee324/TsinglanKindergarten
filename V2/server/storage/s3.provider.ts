/**
 * server/storage/s3.provider.ts —— S3 兼容对象存储（生产）
 * ============================================================================
 * 支持 Cloudflare R2 / AWS S3 / MinIO —— **同一段代码**，差别只在配置
 * （endpoint / region / bucket / forcePathStyle）。
 *
 * 三件必须写清楚的事：
 *
 * ① **完整性写在签名里。**
 *    `presignPut` 把 `x-amz-checksum-sha256` 放进**已签名头**。
 *    浏览器 PUT 时字节与这个哈希不一致，S3 自己就会拒（实测 SeaweedFS 返回
 *    `400 BadDigest` 且对象不落地）。比"上传完再回读校验"强一个量级：
 *    坏数据根本没机会进入桶里。
 *
 * ② **必须关掉 SDK 的默认校验和注入。**
 *    新版 AWS SDK 默认给每个请求加 `x-amz-checksum-crc32`。预签名时 body 还不知道，
 *    于是 URL 里被写进**空 body 的 CRC32**；真上传时服务端算出真实 CRC32 不符，
 *    直接 `BadDigest 400`。这个坑是实测撞出来的（见 docs/STORAGE.md）。
 *
 * ③ **checksum 不能被"提升"到 query string。**
 *    SDK 默认会把 `x-amz-checksum-*` 提升成 query 参数，而部分 S3 兼容实现
 *    （实测 SeaweedFS 4.48）在验签时对 query 里的 checksum 处理不一致，
 *    结果是 `SignatureDoesNotMatch`。用 `unhoistableHeaders` 强制它留在签名头里，
 *    所有实现都能正确处理。
 */
import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Injectable } from '@nestjs/common'
import { loadConfig } from '../config'
import {
  type ObjectStat,
  type ObjectVerification,
  type PresignGetOptions,
  type PresignedGet,
  type PresignedPut,
  type PresignPutOptions,
  type StorageHealth,
  type StorageProvider,
  StorageNotConfiguredError,
  StorageUnavailableError,
} from './storage.provider'

/** 上传时要带、并且必须与签名完全一致的头。 */
const CHECKSUM_HEADER = 'x-amz-checksum-sha256'

@Injectable()
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const
  private readonly config = loadConfig()
  private client: S3Client | null = null

  private s3(): S3Client {
    const c = this.config.storage
    if (
      c.bucket === '' ||
      c.accessKey === '' ||
      c.secretKey === '' ||
      c.endpoint === ''
    ) {
      throw new StorageNotConfiguredError(
        '对象存储未配置：需要 STORAGE_ENDPOINT / STORAGE_BUCKET / STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY',
      )
    }
    if (this.client === null) {
      this.client = new S3Client({
        endpoint: c.endpoint,
        region: c.region,
        forcePathStyle: c.forcePathStyle,
        credentials: { accessKeyId: c.accessKey, secretAccessKey: c.secretKey },
        // ① 见文件头注释：关掉默认校验和注入，否则预签名 URL 会被 S3 判为 BadDigest。
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        maxAttempts: 3,
      })
    }
    return this.client
  }

  async presignPut(storageKey: string, options: PresignPutOptions): Promise<PresignedPut> {
    const checksumBase64 = Buffer.from(options.sha256.toLowerCase(), 'hex').toString('base64')
    const url = await getSignedUrl(
      this.s3(),
      new PutObjectCommand({
        Bucket: this.config.storage.bucket,
        Key: storageKey,
        ContentType: options.contentType,
        ContentLength: options.size,
        ChecksumSHA256: checksumBase64,
      }),
      {
        expiresIn: this.config.storagePutTtlSeconds,
        // 这些头参与签名 → 客户端必须原样发送，值改一个字就 403。
        signableHeaders: new Set(['content-type', CHECKSUM_HEADER]),
        // ② 见文件头注释：强制 checksum 留在签名头里，不要提升成 query。
        unhoistableHeaders: new Set([CHECKSUM_HEADER]),
      },
    )
    return {
      storageKey,
      url,
      method: 'PUT',
      headers: { 'content-type': options.contentType, [CHECKSUM_HEADER]: checksumBase64 },
      expiresInSeconds: this.config.storagePutTtlSeconds,
    }
  }

  async presignGet(storageKey: string, options: PresignGetOptions): Promise<PresignedGet> {
    const url = await getSignedUrl(
      this.s3(),
      new GetObjectCommand({
        Bucket: this.config.storage.bucket,
        Key: storageKey,
        // 类型与处置方式由**服务端**决定，不由客户端传参决定 ——
        // 否则 a.txt 可以被要求以 text/html 返回，从而在浏览器里执行（§36）。
        ResponseContentType: options.contentType,
        ResponseContentDisposition:
          options.disposition === 'attachment'
            ? contentDispositionAttachment(options.fileName)
            : 'inline',
        // §38：私有资源不能被浏览器长期缓存。
        ResponseCacheControl: 'private, no-store, max-age=0',
      }),
      { expiresIn: this.config.storageGetTtlSeconds },
    )
    return { url, expiresInSeconds: this.config.storageGetTtlSeconds }
  }

  async head(storageKey: string): Promise<ObjectStat | null> {
    try {
      const head = await this.s3().send(
        new HeadObjectCommand({ Bucket: this.config.storage.bucket, Key: storageKey }),
      )
      return {
        key: storageKey,
        size: Number(head.ContentLength ?? 0),
        contentType: head.ContentType ?? 'application/octet-stream',
        sha256: base64ToHex(head.ChecksumSHA256),
        etag: head.ETag ?? null,
        createdAt: head.LastModified ?? null,
      }
    } catch (error) {
      if (isNotFound(error)) return null
      throw new StorageUnavailableError(describe(error), error)
    }
  }

  /**
   * 登记前的校验。
   *
   * 顺序：对象在不在 → 大小对不对 → 能不能再确认一次内容哈希。
   * 最后一步拿不到时**不编造**：返回 `upload-integrity-header`，
   * 如实说明"哈希是在上传时由存储层强制校验的，这里没有再验一遍"。
   * 这正是业主 §8 想要的效果，而且不需要把资料从桶里回流一遍 VPS。
   */
  async verify(
    storageKey: string,
    expected: { size: number; sha256: string },
  ): Promise<ObjectVerification> {
    const stat = await this.head(storageKey)
    if (stat === null) return { ok: false, method: 'provider-checksum', reason: 'NOT_FOUND' }
    if (stat.size !== expected.size) {
      return {
        ok: false,
        method: 'provider-checksum',
        reason: 'SIZE_MISMATCH',
        detail: `实际 ${stat.size} 字节，声明 ${expected.size} 字节`,
      }
    }
    if (stat.sha256 !== null) {
      if (stat.sha256 !== expected.sha256.toLowerCase()) {
        return {
          ok: false,
          method: 'provider-checksum',
          reason: 'HASH_MISMATCH',
          detail: `实际 ${stat.sha256}，声明 ${expected.sha256.toLowerCase()}`,
        }
      }
      return { ok: true, method: 'provider-checksum' }
    }
    return { ok: true, method: 'upload-integrity-header' }
  }

  async read(storageKey: string): Promise<Buffer> {
    try {
      const res = await this.s3().send(
        new GetObjectCommand({ Bucket: this.config.storage.bucket, Key: storageKey }),
      )
      const bytes = await res.Body?.transformToByteArray()
      if (bytes === undefined) throw new StorageUnavailableError('对象读取返回空 body')
      return Buffer.from(bytes)
    } catch (error) {
      if (isNotFound(error)) throw new StorageUnavailableError('对象不存在', error)
      throw new StorageUnavailableError(describe(error), error)
    }
  }

  /**
   * 只取对象开头 `bytes` 个字节（magic bytes 验真用）。
   *
   * 用 HTTP Range 而不是整对象：一份 50MB 的课件，登记时只回传 64 字节。
   * 这正是"浏览器直传、VPS 不搬运文件流量"这个设计要保住的性质。
   */
  async readRange(storageKey: string, bytes: number): Promise<Buffer> {
    try {
      const res = await this.s3().send(
        new GetObjectCommand({
          Bucket: this.config.storage.bucket,
          Key: storageKey,
          Range: `bytes=0-${Math.max(0, bytes - 1)}`,
        }),
      )
      const out = await res.Body?.transformToByteArray()
      return Buffer.from(out ?? new Uint8Array())
    } catch (error) {
      if (isNotFound(error)) throw new StorageUnavailableError('对象不存在', error)
      throw new StorageUnavailableError(describe(error), error)
    }
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await this.s3().send(
        new DeleteObjectCommand({ Bucket: this.config.storage.bucket, Key: storageKey }),
      )
    } catch (error) {
      if (isNotFound(error)) return
      throw new StorageUnavailableError(describe(error), error)
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    let token: string | undefined
    try {
      do {
        const page = await this.s3().send(
          new ListObjectsV2Command({
            Bucket: this.config.storage.bucket,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: 1000,
          }),
        )
        for (const obj of page.Contents ?? []) {
          if (typeof obj.Key === 'string') out.push(obj.Key)
        }
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined
      } while (token !== undefined)
      return out
    } catch (error) {
      throw new StorageUnavailableError(describe(error), error)
    }
  }

  async health(): Promise<StorageHealth> {
    const c = this.config.storage
    const missing = [
      ['STORAGE_ENDPOINT', c.endpoint],
      ['STORAGE_BUCKET', c.bucket],
      ['STORAGE_ACCESS_KEY', c.accessKey],
      ['STORAGE_SECRET_KEY', c.secretKey],
    ]
      .filter(([, v]) => v === '')
      .map(([k]) => k)
    if (missing.length > 0) {
      // 只说**缺了哪个变量名**，绝不说值 —— §21 生产禁止把凭据写进日志。
      return {
        provider: 's3',
        configured: false,
        reachable: false,
        detail: `缺少环境变量：${missing.join(' / ')}`,
      }
    }
    try {
      await this.s3().send(new HeadBucketCommand({ Bucket: c.bucket }))
      return { provider: 's3', configured: true, reachable: true, detail: '对象存储可访问' }
    } catch (error) {
      return {
        provider: 's3',
        configured: true,
        reachable: false,
        detail: `无法访问对象存储：${describe(error)}`,
      }
    }
  }
}

/**
 * 桶的 CORS 策略（业主 §37）。
 *
 * 浏览器直传必须是**跨域 PUT**（页面在应用域名下，对象存储在自己域名下），
 * 所以桶一定要配 CORS。两条纪律：
 *
 *   1. **绝不允许 `*`。** 那样任何网站都能拿着用户浏览器里的签名地址发请求
 *      （签名地址本身是短命的，但没有必要把门开到最大）。
 *   2. 只允许把 `content-type` 与 `x-amz-checksum-sha256` 作为请求头 ——
 *      后者是完整性保证，必须允许，但仅此而已。
 *
 * 这个函数是**唯一**的 CORS 定义：`scripts/configure-bucket-cors.mjs` 用它写桶，
 * 测试用它断言"落到桶上的策略不是通配符"。写两份迟早会漂移。
 */
export function buildBucketCorsPolicy(origins: readonly string[]) {
  const cleaned = origins.map((o) => o.trim()).filter((o) => o !== '')
  if (cleaned.length === 0) {
    throw new Error('CORS 至少要有一个正式 origin —— 不允许留空，更不允许用 *')
  }
  if (cleaned.includes('*')) {
    throw new Error('CORS 不允许使用 *（业主 §37）：只允许 V2 的正式 origin')
  }
  return {
    CORSRules: [
      {
        AllowedOrigins: cleaned,
        AllowedMethods: ['PUT', 'GET', 'HEAD'],
        AllowedHeaders: ['content-type', 'x-amz-checksum-sha256', 'x-amz-date', 'authorization'],
        ExposeHeaders: ['ETag', 'x-amz-checksum-sha256'],
        MaxAgeSeconds: 3600,
      },
    ],
  }
}

/** 检查一个已存在的策略里有没有通配符 origin（配置巡检用）。 */
export function corsPolicyHasWildcard(policy: {
  CORSRules?: readonly { AllowedOrigins?: readonly string[] }[]
}): boolean {
  return (policy.CORSRules ?? []).some((rule) => (rule.AllowedOrigins ?? []).includes('*'))
}

/**
 * `attachment; filename*=UTF-8''…`
 *
 * 中文文件名必须走 `filename*`（RFC 5987），并且把引号/换行去掉 ——
 * 它会被写进响应头，是注入点。
 */
export function contentDispositionAttachment(fileName: string): string {
  const sanitized = fileName.replace(/["\\\r\n]/g, '_')
  const asciiFallback = sanitized.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(sanitized)}`
}

/** S3 的 `ChecksumSHA256` 是 base64；数据库里存的是 hex。 */
function base64ToHex(value: string | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null
  try {
    const buf = Buffer.from(value, 'base64')
    if (buf.byteLength !== 32) return null
    return buf.toString('hex')
  } catch {
    return null
  }
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** 供测试/脚本用：算 base64 形式的 sha256（S3 的 checksum 头格式）。 */
export function sha256Base64(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('base64')
}
