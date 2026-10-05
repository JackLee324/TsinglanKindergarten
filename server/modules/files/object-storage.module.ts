import { Module } from '@nestjs/common';
import { OBJECT_STORAGE, UnconfiguredObjectStorage } from './object-storage';

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
@Module({
  providers: [{ provide: OBJECT_STORAGE, useClass: UnconfiguredObjectStorage }],
  exports: [OBJECT_STORAGE],
})
export class ObjectStorageModule {}
