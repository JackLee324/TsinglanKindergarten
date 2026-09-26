import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Object storage, as an interface this application owns.
 * =====================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Downloads used to be served by asking the 妙搭 platform's object store
 * (dataloom, reached through `@lark-apaas/file-service`) for a short-lived signed
 * URL. Off the platform there is no such store, and the honest consequence is that
 * an upload can be *registered* (metadata plus a base64 head, stored in
 * PostgreSQL) but its bytes cannot be served. `scripts/verify-files-http.mjs`
 * section C pins exactly that: the request is fully authorised, the token is
 * valid, and the answer is still a 503 with no URL in it.
 *
 * That behaviour is correct and is kept. What was missing is a seam: the code
 * called a concrete platform class, so "plug in S3/R2/MinIO later" meant editing
 * the download path. This interface is that seam, and nothing more — it is
 * deliberately the smallest surface the download endpoint needs:
 *
 *     isConfigured()                       -> can this process sign anything at all?
 *     createSignedUrl({bucketId, path, ttl}) -> a real, short-lived URL, or a throw
 *     close?()                             -> release a local handle, if the backend has one
 *
 * WHAT AN IMPLEMENTATION MUST NEVER DO
 * ------------------------------------
 * Return a placeholder, an empty string, a relative path, or any URL it did not
 * receive from the storage service. A download that cannot be served must look
 * broken. A link that looks fine and does nothing is the failure mode this
 * interface exists to make impossible: the user clicks, gets a blank tab, and
 * reports "the platform is broken" with no server-side trace to work from.
 *
 * HOW THE TWO FAILURES ARE DISTINGUISHED
 * --------------------------------------
 *   STORAGE_NOT_CONFIGURED — no backend is configured in this process. Detected
 *                            BEFORE any signing is attempted, so it is
 *                            deterministic rather than inferred from a downstream
 *                            error message. This is the state of every deployment
 *                            today, and it is what the default provider returns.
 *   STORAGE_UNAVAILABLE    — a backend IS configured but the call failed
 *                            (network, credentials, permissions, an empty answer).
 *
 * Both are 503, both carry their code in the response body
 * (`error.details.code`), and neither ever contains a URL.
 */

/** Injection token for the configured backend. */
export const OBJECT_STORAGE = 'OBJECT_STORAGE';

export const STORAGE_NOT_CONFIGURED_CODE = 'STORAGE_NOT_CONFIGURED';
export const STORAGE_UNAVAILABLE_CODE = 'STORAGE_UNAVAILABLE';

export interface SignedUrlRequest {
  /** The bucket the object lives in, as recorded on the resource row. */
  bucketId: string;
  /** Bucket-relative object key. Already traversal-checked by ResourcesService. */
  filePath: string;
  /** Requested lifetime in seconds. */
  ttlSeconds: number;
}

export interface ObjectStorage {
  /** Human-readable backend name, for logs. Never a credential or an endpoint. */
  readonly name: string;
  /** Whether this process can sign at all. Must not perform I/O if it can avoid it. */
  isConfigured(): Promise<boolean>;
  /** A real signed URL. Throws `ServiceUnavailableException` on every failure path. */
  createSignedUrl(request: SignedUrlRequest): Promise<string>;
  /** Optional: release a local handle (a connection pool, a credential cache). */
  close?(): Promise<void>;
}

/** The message for STORAGE_NOT_CONFIGURED, exported so tests assert the same text. */
export const STORAGE_NOT_CONFIGURED_MESSAGE =
  '文件存储后端未接入（STORAGE_NOT_CONFIGURED）：本进程没有配置任何对象存储后端，' +
  '服务端无法生成真实的对象存储签名直链，因此本次下载被拒绝，未返回任何无效或伪造的地址。' +
  '接入方式：实现 server/modules/files/object-storage.ts 的 ObjectStorage 接口（S3 / Cloudflare R2 / MinIO 等）' +
  '并把它注册为 OBJECT_STORAGE provider。' +
  '详细原因见服务端日志（可用响应中的 requestId 关联）。';

/** The message for STORAGE_UNAVAILABLE. */
export const STORAGE_UNAVAILABLE_MESSAGE =
  '文件存储后端不可用（STORAGE_UNAVAILABLE）：调用对象存储签名接口失败，本次下载被拒绝，' +
  '未返回任何无效或伪造的地址。请检查存储后端配置与网络连通性。' +
  '详细原因见服务端日志（可用响应中的 requestId 关联）。';

/**
 * Both failures throw this shape: an `HttpException` whose body carries a
 * machine-readable `code`, so a client can branch on the cause instead of
 * matching on Chinese prose.
 */
export function storageUnavailable(code: string, message: string): ServiceUnavailableException {
  return new ServiceUnavailableException({ code, message });
}

/**
 * The default provider: no backend at all.
 *
 * This is not a stub that pretends to work — it is the truthful implementation of
 * "this deployment has no object storage", and it is what keeps the download
 * endpoint honest rather than merely broken. Replacing it is a one-line change in
 * `FilesModule` once a real backend exists.
 */
export class UnconfiguredObjectStorage implements ObjectStorage {
  readonly name = 'unconfigured';

  isConfigured(): Promise<boolean> {
    return Promise.resolve(false);
  }

  createSignedUrl(): Promise<string> {
    // Reached only if a caller skips the isConfigured() pre-flight; the answer is
    // the same either way, because there is genuinely nothing to sign with.
    return Promise.reject(
      storageUnavailable(STORAGE_NOT_CONFIGURED_CODE, STORAGE_NOT_CONFIGURED_MESSAGE),
    );
  }
}
