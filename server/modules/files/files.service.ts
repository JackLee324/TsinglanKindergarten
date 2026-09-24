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
 * The signed URL is obtained with the platform's PUBLIC API —
 * `createSignedUrl(path, expiresIn)` on a bucket-scoped client — not by
 * hand-building `/api/__platform__/storage/download?bucket=…&path=…`. The
 * hand-built form was the previous implementation: unauthenticated, never
 * expiring, and it disclosed the object's location inside a private bucket.
 * (`createSignedUrl` is an ordinary API call, not a presigned-S3-style local
 * signature: the platform returns a URL with its own short expiry, so this
 * method still performs a real round-trip and can still fail — which is exactly
 * why the failure path below matters.)
 *
 * It is NOT reachable from a local/standalone process: the platform supplies the
 * app id, credentials and bucket through its per-request context, and without
 * them there is nothing to sign against. In that situation this service REFUSES,
 * loudly, with a 503 naming the missing integration. It never:
 *   * returns a placeholder URL;
 *   * returns an empty string or a relative path that the browser would resolve
 *     against our own origin;
 *   * swallows the platform error and reports success.
 *
 * HOW AVAILABILITY IS DETECTED — PUBLIC API ONLY
 * ----------------------------------------------
 * `FileService`'s own `getAppId()` is declared PRIVATE in the platform typings
 * (`fullstack-nestjs-core/dist/index.d.ts`), so calling it is a compile error
 * (`TS2341`) — and reaching into it with a cast would couple this service to a
 * private field. There is, however, a public probe:
 *
 *   * `getDefaultBucket()` resolves the bucket for the current request context.
 *     An empty result (or a throw) means the process has no platform storage
 *     context, i.e. storage is not configured — which is reported as such
 *     BEFORE any signing is attempted, so the "not configured" case is
 *     deterministic rather than inferred from a downstream error message.
 *   * `createSignedUrl(path, expiresIn)` then does the actual work, and its own
 *     failure is translated into a distinct 503 (configured-but-unreachable).
 *
 * Both failures are 503 and both name `@lark-apaas/file-service` / dataloom; the
 * underlying platform error is logged server-side only, because it can contain
 * the internal storage host and the object path (see the G-11
 * error-sanitisation finding).
 *
 * The failure path is a feature: a download that cannot be served honestly must
 * look broken, rather than hand the user a link that looks fine and does nothing.
 */

/** No platform storage context at all: `getDefaultBucket()` was empty or threw. */
export const STORAGE_NOT_CONFIGURED_MESSAGE =
  '文件存储后端未接入：本进程没有可用的平台对象存储上下文（@lark-apaas/file-service / dataloom 未提供 bucket 或 appId），' +
  '服务端无法生成真实的对象存储签名直链，因此本次下载被拒绝，未返回任何无效或伪造的地址。' +
  '独立部署出现此错误说明平台文件服务尚未接入；妙搭平台部署请检查文件服务配置。' +
  '详细原因见服务端日志（可用响应中的 requestId 关联）。';

/** Storage context exists but the signing call failed (network, credentials, permissions). */
export const STORAGE_UNAVAILABLE_MESSAGE =
  '文件存储后端不可用：调用平台对象存储签名接口失败（@lark-apaas/file-service / dataloom），本次下载被拒绝，' +
  '未返回任何无效或伪造的地址。请检查文件服务配置与网络连通性。' +
  '详细原因见服务端日志（可用响应中的 requestId 关联）。';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(private readonly fileService: FileService) {}

  /**
   * Is a platform storage context available to THIS request?
   *
   * Uses only the public API. `getDefaultBucket()` returns the context bucket
   * when the platform middleware supplied one, and otherwise asks the platform
   * for the app's default bucket — so an empty answer or a throw both mean "this
   * process cannot sign anything". Never assumes success: an exception here is
   * caught, logged, and reported as NOT configured.
   */
  async isStorageConfigured(): Promise<boolean> {
    try {
      const bucket = await this.fileService.getDefaultBucket();
      if (typeof bucket === 'string' && bucket.length > 0) return true;
      this.logger.warn(
        'platform file storage context is empty (getDefaultBucket() returned no bucket)',
      );
      return false;
    } catch (error) {
      this.logger.warn(
        `platform file storage context unavailable: ${(error as Error)?.message ?? String(error)}`,
      );
      return false;
    }
  }

  /**
   * Ask the platform object store for a short-lived signed URL.
   *
   * `bucketId` and `filePath` have already been shape-checked and traversal-
   * checked by `ResourcesService.authorizeDownload()` (and the path normalised
   * to a bucket-relative key); empty input is refused again here, because a
   * request built from an empty path would sign the whole bucket prefix.
   *
   * Throws `ServiceUnavailableException` (503) on EVERY failure path, with the
   * two distinct messages above.
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

    // Pre-flight, public API only. Distinct from the call failure below so an
    // operator can tell "never configured" from "configured but broken".
    if (!(await this.isStorageConfigured())) {
      throw new ServiceUnavailableException(STORAGE_NOT_CONFIGURED_MESSAGE);
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
