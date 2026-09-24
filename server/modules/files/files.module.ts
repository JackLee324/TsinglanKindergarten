import { Module } from '@nestjs/common';

import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { ResourcesModule } from '../resources/resources.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Download-token consumption.
 *
 * Imports ResourcesModule (for the SAME `ResourcesService.authorizeDownload()`
 * the link-issuing endpoint uses — one implementation of the permission rules)
 * and AuditModule (for the shared audit writer). `FileService` itself comes from
 * the global PlatformModule, exactly as it does in ResourcesModule.
 */
@Module({
  imports: [ResourcesModule, AuditModule],
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
