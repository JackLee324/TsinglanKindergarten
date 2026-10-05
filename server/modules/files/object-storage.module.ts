import { Module } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { OBJECT_STORAGE, UnconfiguredObjectStorage, type ObjectStorage } from './object-storage';
import { S3ObjectStorage, readS3Config } from './s3-object-storage';

/**
 * The single binding site for the object-storage backend.
 *
 * WHY THIS MODULE EXISTS (and why the provider is not bound in `FilesModule`)
 * -------------------------------------------------------------------------
 * The binding used to live in `FilesModule`, so only the download path could ask
 * "can this process sign at all?". The upload path (`ResourcesService.registerFile`)
 * could not — and that asymmetry was a real defect, not a tidiness issue:
 *
 *   `registerFile` accepted a client-supplied `fileBucketId`/`filePath` and wrote
 *   them onto the row. Because `resources.has_stored_file` is GENERATED from
 *   "path AND bucket non-blank" (migration 0008), the row then claimed a stored
 *   file, the UI enabled 下载, and the download returned 503 — the exact
 *   "looks fine, does nothing" failure `object-storage.ts` exists to prevent,
 *   just moved one step earlier.
 *
 * `ResourcesModule` cannot import `FilesModule` to reach the provider, because
 * `FilesModule` already imports `ResourcesModule` (circular). So the binding moves
 * here and both modules import THIS one. There is still exactly one place that
 * decides which backend the process uses.
 */
/**
 * 选择后端：配齐了 S3 就用 S3，否则仍然用"诚实的未配置"实现。
 *
 * 判定条件只看**四处必需配置是否齐全**（endpoint / bucket / access key / secret）。
 * 缺任何一项都退回未配置实现 —— 不猜默认凭据、不用空字符串凑合，
 * 因为一个"半配置"的存储后端会以 403/网络错误的形式出现在下载路径上，
 * 而那比明确说"没配置"难排查得多。
 */
function createObjectStorage(): ObjectStorage {
  const cfg = readS3Config();
  if (cfg) {
    // 只在日志里说后端类型与 bucket 名，绝不打印凭据。
    new Logger('ObjectStorageModule').log(
      `object storage backend: s3 (endpoint=${cfg.endpoint}, bucket=${cfg.bucket}, region=${cfg.region})`,
    );
    return new S3ObjectStorage(cfg);
  }
  return new UnconfiguredObjectStorage();
}

@Module({
  providers: [{ provide: OBJECT_STORAGE, useFactory: createObjectStorage }],
  exports: [OBJECT_STORAGE],
})
export class ObjectStorageModule {}
