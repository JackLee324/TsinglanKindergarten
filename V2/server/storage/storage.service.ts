/**
 * server/storage/storage.service.ts —— 存储门面（业务代码只认这个）
 * ============================================================================
 * 按配置选一个驱动（local / s3），把驱动特有的错误翻译成带**机器可读 code**
 * 的业务错误（§20），并把 key 的生成规则收在一处。
 *
 * 业务代码（files 模块）不 import 任何驱动，也不 import 任何 AWS SDK 类型 ——
 * 换存储平台时只动 config，不动调用方。
 */
import { Injectable } from '@nestjs/common'
import { loadConfig } from '../config'
import { AppError } from '../common/http-error'
import { safeFileNameSegment } from '../../shared/file-policy'
import { LocalStorageProvider, newStorageKey } from './local.provider'
import {
  type ObjectStat,
  type ObjectVerification,
  type PresignGetOptions,
  type PresignedGet,
  type PresignedPut,
  type PresignPutOptions,
  type StorageHealth,
  type StorageProvider,
  type StorageProviderName,
  StorageNotConfiguredError,
  StorageUnavailableError,
} from './storage.provider'
import { S3StorageProvider } from './s3.provider'

@Injectable()
export class StorageService {
  private readonly config = loadConfig()

  constructor(
    private readonly local: LocalStorageProvider,
    private readonly s3: S3StorageProvider,
  ) {}

  get providerName(): StorageProviderName {
    return this.config.storage.provider
  }

  get provider(): StorageProvider {
    return this.providerName === 's3' ? this.s3 : this.local
  }

  get localProvider(): LocalStorageProvider {
    return this.local
  }

  /**
   * 生成对象 key。
   *
   * 形状固定为 `resources/{resourceId}/{uuid}-{safeName}`（业主 §7）：
   *   · 用户文件名**不参与目录结构**，`../` 即使漏过校验也无从穿越；
   *   · 每个资源一个前缀，清理孤儿对象时可以按前缀扫；
   *   · uuid 前缀保证同名文件不会互相覆盖 —— 业主 §16 明确要求
   *     "教案.pdf 与 教案-v2.pdf 都要留下，不能因为重名覆盖旧文件"。
   */
  newKey(resourceId: string, fileName: string): string {
    return newStorageKey(resourceId, safeFileNameSegment(fileName))
  }

  async presignPut(storageKey: string, options: PresignPutOptions): Promise<PresignedPut> {
    return this.guard(() => this.provider.presignPut(storageKey, options))
  }

  async presignGet(storageKey: string, options: PresignGetOptions): Promise<PresignedGet> {
    return this.guard(() => this.provider.presignGet(storageKey, options))
  }

  async head(storageKey: string): Promise<ObjectStat | null> {
    return this.guard(() => this.provider.head(storageKey))
  }

  async verify(
    storageKey: string,
    expected: { size: number; sha256: string },
  ): Promise<ObjectVerification> {
    return this.guard(() => this.provider.verify(storageKey, expected))
  }

  async read(storageKey: string): Promise<Buffer> {
    return this.guard(() => this.provider.read(storageKey))
  }

  async readRange(storageKey: string, bytes: number): Promise<Buffer> {
    return this.guard(() => this.provider.readRange(storageKey, bytes))
  }

  /** 上传地址（写操作）的有效期。 */
  get presignPutTtlSeconds(): number {
    return this.config.storagePutTtlSeconds
  }

  /** 预览 / 下载地址的有效期。 */
  get presignTtlSeconds(): number {
    return this.config.storageGetTtlSeconds
  }

  async delete(storageKey: string): Promise<void> {
    return this.guard(() => this.provider.delete(storageKey))
  }

  async list(prefix: string): Promise<string[]> {
    return this.guard(() => this.provider.list(prefix))
  }

  async health(): Promise<StorageHealth> {
    return this.guard(() => this.provider.health())
  }

  /**
   * 把驱动错误翻译成业务错误。
   *
   * 「存储没配好」和「存储暂时连不上」必须分开，因为它们的处理方式完全不同：
   * 前者要找管理员改配置，后者重试就行（§20）。
   */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof StorageNotConfiguredError) {
        throw AppError.serviceUnavailable(
          '文件存储服务尚未配置，请联系管理员。',
          'STORAGE_NOT_CONFIGURED',
        )
      }
      if (error instanceof StorageUnavailableError) {
        throw AppError.serviceUnavailable(
          '文件存储服务暂时不可用，请稍后重试。',
          'STORAGE_UNAVAILABLE',
        )
      }
      throw error
    }
  }
}

// 重新导出，避免调用方为了拿这些名字去 import 具体的驱动文件。
export { STORAGE_KEY_PATTERN, isValidStorageKey, storageKeyBelongsTo, sha256Hex } from './local.provider'
export type { StorageProviderName }
export { StorageNotConfiguredError, StorageUnavailableError }
export { S3StorageProvider, LocalStorageProvider }
export type { ObjectStat, ObjectVerification, StorageHealth }
export type { PresignGetOptions, PresignPutOptions, PresignedGet, PresignedPut }
