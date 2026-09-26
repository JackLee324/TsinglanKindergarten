import { Module } from '@nestjs/common';

import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { OBJECT_STORAGE, UnconfiguredObjectStorage } from './object-storage';
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
 *     { provide: OBJECT_STORAGE, useClass: S3ObjectStorage }
 *
 * Nothing else in the download path has to move.
 */
@Module({
  imports: [ResourcesModule, AuditModule],
  controllers: [FilesController],
  providers: [
    FilesService,
    { provide: OBJECT_STORAGE, useClass: UnconfiguredObjectStorage },
  ],
})
export class FilesModule {}
