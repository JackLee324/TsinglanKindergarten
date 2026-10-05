import { Module } from '@nestjs/common';

import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { ObjectStorageModule } from './object-storage.module';
import { ResourcesModule } from '../resources/resources.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Download-token consumption.
 *
 * Imports ResourcesModule (for the SAME `ResourcesService.authorizeDownload()`
 * the link-issuing endpoint uses — one implementation of the permission rules)
 * and AuditModule (for the shared audit writer).
 *
 * THE STORAGE PROVIDER IS THE ONE LINE TO CHANGE LATER
 * ---------------------------------------------------
 * `UnconfiguredObjectStorage` is the truthful "this deployment has no object
 * store" backend: every download is refused with 503 STORAGE_NOT_CONFIGURED and
 * no URL is ever fabricated. To serve real bytes, implement the `ObjectStorage`
 * interface (S3, Cloudflare R2, MinIO, …) and bind it here:
 *
 *     （绑定点现在在 ObjectStorageModule）{ provide: OBJECT_STORAGE, useClass: S3ObjectStorage }
 *
 * Nothing else in the download path has to move.
 */
@Module({
  // ObjectStorageModule owns the OBJECT_STORAGE binding (see its header) —— 这里不再
// 自己 provide，避免出现第二个"谁来当后端"的判定点。
imports: [ObjectStorageModule, ResourcesModule, AuditModule],
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
