import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { FileService } from '@lark-apaas/fullstack-nestjs-core';

/**
 * Platform object-storage access for downloads.
 * =============================================
 *
 * WHAT THIS WIRES (and what it deliberately does not)
 * --------------------------------------------------
 * The real object store on the 妙搭 platform is dataloom, reached through
 * `@lark-apaas/file-service` (re-exported by `fullstack-nestjs-core` as
 * `FileService`). This service is the single place that talks to it, so the
 * download endpoint has exactly one storage dependency to reason about.
 *
 * It is NOT reachable from a local/standalone process: the platform injects an
 * `appId` and storage credentials into the per-request context, and without them
 * there is no bucket to sign against. In that situation this service REFUSES,
 * loudly, with a 503 naming the missing integration. It never:
 *   * returns a placeholder URL — the previous implementation's
 *     `/api/__platform__/storage/download?bucket=…&path=…` was unauthenticated,
 *     never expired, and disclosed the object's location in a private bucket;
 *   * returns an empty string or a relative path that the browser would resolve
 *     against our own origin;
 *   * swallows the platform error and reports success.
 *
 * WHY THE FAILURE IS DETECTED BY ATTEMPTING THE CALL
 * --------------------------------------------------
 * `FileService` exposes no public "is storage configured?" probe: `getAppId()` is
 * declared private, and reading the platform request context directly would mean
 * importing `@lark-apaas/nestjs-common`, which this project does not declare as a
 * dependency. Rather than reach into private API or add an undeclared import, this
 * service attempts the real call and translates its failure into an explicit 503.
 * The outcome is the same as a pre-flight check — the download fails where an
 * operator can see it — and the underlying error is logged server-side instead of
 * being hidden.
 *
 * The failure path is a feature: a download that cannot be served honestly must
 * look broken, rather than hand the user a link that looks fine and does nothing.
 */

/** Emitted (and asserted by the HTTP suite) for every storage failure. */
export const STORAGE_UNAVAILABLE_MESSAGE =
  '文件存储后端不可用：本部署无法通过平台对象存储（@lark-apaas/file-service / dataloom）取得对象的签名直链，' +
  '因此本次下载被拒绝，未返回任何无效或伪造的地址。独立部署出现此错误说明平台文件服务尚未接入；' +
  '妙搭平台部署出现此错误请检查文件服务配置与网络连通性。详细原因见服务端日志（可用响应中的 requestId 关联）。';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(private readonly fileService: FileService) {}

  /**
   * Ask the platform object store for a short-lived signed URL.
   *
   * `bucketId` and `filePath` have already been shape-checked and traversal-
   * checked by `ResourcesService.authorizeDownload()`; empty input is refused
   * again here because a request built from an empty path would sign the whole
   * bucket prefix.
   *
   * Throws `ServiceUnavailableException` (503) on EVERY failure path. The
   * underlying platform error is logged server-side only — it can contain the
   * internal storage host and the object path, which must not reach the client
   * (see the G-11 error-sanitisation finding).
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

    let signed: string;
    try {
      signed = await this.fileService
        .from(bucketId)
        .createSignedUrl(filePath, ttlSeconds);
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      this.logger.error(
        `platform object storage signing failed (bucket=${bucketId}): ${message}`,
      );
      throw new ServiceUnavailableException(STORAGE_UNAVAILABLE_MESSAGE);
    }

    if (typeof signed !== 'string' || signed.length === 0) {
      // Success-shaped but useless: an empty URL is exactly the "silent success"
      // this method must never produce.
      this.logger.error(
        `platform object storage returned an empty signed URL (bucket=${bucketId})`,
      );
      throw new ServiceUnavailableException(STORAGE_UNAVAILABLE_MESSAGE);
    }

    return signed;
  }
}
