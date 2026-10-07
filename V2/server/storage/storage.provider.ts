/**
 * server/storage/storage.provider.ts —— 对象存储的**契约**
 * ============================================================================
 * 两个实现：`LocalStorageProvider`（开发）与 `S3StorageProvider`（生产，S3 兼容）。
 *
 * 业务代码（files 模块）只依赖这个接口，**不认识任何一家存储平台** ——
 * Cloudflare R2 / AWS S3 / MinIO 用同一段代码，差别只在配置里。
 *
 * 接口里最重要的两个方法是 `presignPut` 与 `verify`，它们共同承担业主 §8 的要求：
 * **"sha256 必须真的对得上，而不是文件名相同就算成功"**。
 *
 * 完整性与它们的分工：
 *   · `presignPut` 把 sha256 **写进签名**（本地驱动写进 HMAC 令牌，
 *     S3 驱动写成已签名的 `x-amz-checksum-sha256` 头）。
 *     于是"上传的字节和声明的哈希不一致"会在**存储层**被拒 ——
 *     对象根本不会落地。这是比"上传完再检查"强一个量级的保证。
 *   · `verify` 在登记前确认对象确实存在、大小一致，并在驱动能给出哈希时再比一次。
 *
 * 为什么 `verify` 不无条件把对象下载回来算哈希：那会让**每一份课程资料
 * 都从对象存储回流一次 VPS**，正是业主采用浏览器直传要避免的流量。
 * 所以下载回读只在驱动拿不到哈希时才作为兜底发生，并且由 `method` 如实说明。
 */

export type StorageProviderName = 'local' | 's3'

export interface PresignPutOptions {
  readonly contentType: string
  /** 客户端声明的字节数。写进签名/令牌，上传时由存储层校验。 */
  readonly size: number
  /** 客户端声明的 sha256（hex）。写进签名/令牌，上传时由存储层校验。 */
  readonly sha256: string
}

export interface PresignedPut {
  readonly storageKey: string
  readonly url: string
  readonly method: 'PUT'
  /** 客户端**必须原样发送**的头（S3 会校验签名头，少一个或值不同都会 403）。 */
  readonly headers: Record<string, string>
  readonly expiresInSeconds: number
}

export interface PresignGetOptions {
  readonly disposition: 'inline' | 'attachment'
  readonly fileName: string
  readonly contentType: string
}

export interface PresignedGet {
  readonly url: string
  readonly expiresInSeconds: number
}

export interface ObjectStat {
  readonly key: string
  readonly size: number
  readonly contentType: string
  /** 驱动能拿到对象内容哈希时给出（hex）；拿不到是 `null`，不要编造。 */
  readonly sha256: string | null
  readonly etag: string | null
  /** 对象创建时间（清理脚本用它判断"够不够旧"）。驱动给不出就是 null。 */
  readonly createdAt: Date | null
}

/**
 * 校验方式 —— 如实说明"这次的保证是从哪来的"，测试会按它断言。
 *
 * · `read-back`               把对象读回来自己算 sha256（最强，代价是流量）
 * · `provider-checksum`       存储服务在 HEAD 里回了内容哈希，直接比
 * · `upload-integrity-header` 哈希已在**上传时**被存储层强制校验过
 *                             （签名里带了 checksum），登记时只需确认对象在、大小对
 */
export type VerifyMethod = 'read-back' | 'provider-checksum' | 'upload-integrity-header'

export type VerifyFailure = 'NOT_FOUND' | 'SIZE_MISMATCH' | 'HASH_MISMATCH'

export interface ObjectVerification {
  readonly ok: boolean
  readonly method: VerifyMethod
  readonly reason?: VerifyFailure
  readonly detail?: string
}

export interface StorageHealth {
  readonly provider: StorageProviderName
  /** 配置是否齐全。缺失时**不暴露**缺了哪个密钥值，只说缺了什么名字。 */
  readonly configured: boolean
  /** 真的探测过（HEAD bucket）才算 true。 */
  readonly reachable: boolean
  readonly detail: string
}

export interface StorageProvider {
  readonly name: StorageProviderName

  presignPut(storageKey: string, options: PresignPutOptions): Promise<PresignedPut>
  presignGet(storageKey: string, options: PresignGetOptions): Promise<PresignedGet>

  head(storageKey: string): Promise<ObjectStat | null>
  verify(storageKey: string, expected: { size: number; sha256: string }): Promise<ObjectVerification>

  /** 读回对象字节：仅用于本地驱动的数据面，以及兜底校验/清理脚本。 */
  read(storageKey: string): Promise<Buffer>

  /**
   * 只读对象开头若干字节。
   *
   * 用于登记时做 magic bytes 验真（业主 §5）。S3 走 `Range` 请求，
   * 所以**不需要把整个文件拉回 VPS** —— 一份 50MB 的课件也只传 64 字节回来。
   */
  readRange(storageKey: string, bytes: number): Promise<Buffer>

  delete(storageKey: string): Promise<void>

  /** 列出某个前缀下的 key（孤儿对象清理用）。 */
  list(prefix: string): Promise<string[]>

  health(): Promise<StorageHealth>
}

/** 存储未配置（缺少必需的环境变量）。 */
export class StorageNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageNotConfiguredError'
  }
}

/** 存储不可用（网络/凭证/服务端错误）。**不是**"文件不存在"。 */
export class StorageUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'StorageUnavailableError'
  }
}
