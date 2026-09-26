import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import {
  OBJECT_STORAGE,
  STORAGE_NOT_CONFIGURED_CODE,
  STORAGE_NOT_CONFIGURED_MESSAGE,
  STORAGE_UNAVAILABLE_CODE,
  STORAGE_UNAVAILABLE_MESSAGE,
  storageUnavailable,
  type ObjectStorage,
} from './object-storage';

export {
  STORAGE_NOT_CONFIGURED_CODE,
  STORAGE_NOT_CONFIGURED_MESSAGE,
  STORAGE_UNAVAILABLE_CODE,
  STORAGE_UNAVAILABLE_MESSAGE,
} from './object-storage';

/**
 * Signed-URL issuance for downloads.
 * ==================================
 *
 * WHAT THIS IS NOW
 * ----------------
 * A thin, honest front for whatever `ObjectStorage` implementation is registered
 * (see `object-storage.ts` for the interface and for why it exists). It is the
 * single place the download endpoint talks to storage, so there is exactly one
 * dependency to reason about when a real backend is plugged in.
 *
 * WHAT IT WAS
 * -----------
 * The same service, wired directly to 妙搭's `FileService` (dataloom). Its
 * behaviour in the absence of a backend was already correct — refuse with a 503
 * and never invent a URL — and that behaviour is preserved exactly, message codes
 * included. Only the seam changed.
 *
 * THE CONTRACT, UNCHANGED
 * -----------------------
 *   * "not configured" is decided BEFORE any signing is attempted, so it is
 *     deterministic rather than inferred from a downstream error string;
 *   * a configured backend that fails produces a DIFFERENT 503
 *     (STORAGE_UNAVAILABLE), so an operator can tell "never wired up" from
 *     "wired up and broken";
 *   * an empty or non-string answer from the backend is treated as a failure, not
 *     as success — an empty `href` is the "silent success" this method must never
 *     produce;
 *   * the underlying error is logged server-side only. It can contain the storage
 *     host and the object path, and this project has already had one 5xx-body
 *     credential/path leak (audit finding G-11).
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  /** Is a storage backend available to THIS process? */
  async isStorageConfigured(): Promise<boolean> {
    try {
      return await this.storage.isConfigured();
    } catch (error) {
      this.logger.warn(
        `object storage backend '${this.storage.name}' failed its configuration probe: ` +
          `${(error as Error)?.message ?? String(error)}`,
      );
      return false;
    }
  }

  /**
   * Ask the configured backend for a short-lived signed URL.
   *
   * `bucketId` and `filePath` have already been shape-checked and traversal-
   * checked by `ResourcesService.authorizeDownload()` (and the path normalised to
   * a bucket-relative key); empty input is refused again here, because a request
   * built from an empty path would sign the whole bucket prefix.
   *
   * Throws `ServiceUnavailableException` (503) on EVERY failure path.
   */
  async createSignedStorageUrl(
    bucketId: string,
    filePath: string,
    ttlSeconds: number,
  ): Promise<string> {
    if (!bucketId || !filePath) {
      throw new ServiceUnavailableException(
        '文件存储定位信息不完整（bucket 或 path 为空），无法生成下载直链。',
      );
    }

    if (!(await this.isStorageConfigured())) {
      this.logger.error(
        `object storage is NOT configured in this process (backend='${this.storage.name}'); ` +
          `refusing the download for bucket=${bucketId}`,
      );
      throw storageUnavailable(STORAGE_NOT_CONFIGURED_CODE, STORAGE_NOT_CONFIGURED_MESSAGE);
    }

    let signed: string;
    try {
      signed = await this.storage.createSignedUrl({ bucketId, filePath, ttlSeconds });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.error(
        `object storage signing failed (backend='${this.storage.name}', bucket=${bucketId}): ` +
          `${(error as Error)?.message ?? String(error)}`,
      );
      throw storageUnavailable(STORAGE_UNAVAILABLE_CODE, STORAGE_UNAVAILABLE_MESSAGE);
    }

    if (typeof signed !== 'string' || signed.length === 0) {
      // Success-shaped but useless: an empty URL is exactly the "silent success"
      // this method must never produce.
      this.logger.error(
        `object storage returned an empty signed URL (backend='${this.storage.name}', bucket=${bucketId})`,
      );
      throw storageUnavailable(STORAGE_UNAVAILABLE_CODE, STORAGE_UNAVAILABLE_MESSAGE);
    }

    return signed;
  }
}
