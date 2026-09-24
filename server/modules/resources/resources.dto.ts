import {
  IsString,
  IsOptional,
  IsIn,
  IsNumber,
  Min,
  Max,
  MaxLength,
  IsNotEmpty,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  ProgramCode,
  FolderType,
  ResourceStatus,
  CreateResourceRequest,
  UpdateResourceRequest,
  ResourceListParams,
} from '@shared/api.interface';

const PROGRAM_CODES: ProgramCode[] = ['prek', 'k'];
const FOLDER_TYPES: FolderType[] = [
  'curriculum_outline',
  'weekly_plans',
  'courseware',
  'materials',
  'observation',
  'research_archive',
];
const RESOURCE_STATUSES: ResourceStatus[] = [
  'draft',
  'pending_review',
  'published',
  'rejected',
];

export class ResourceListQueryDto implements ResourceListParams {
  @IsOptional()
  @Type(() => String)
  @IsString()
  @IsIn(PROGRAM_CODES)
  program?: ProgramCode;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  subSubject?: string;

  @IsOptional()
  @Type(() => String)
  @IsString()
  @IsIn(FOLDER_TYPES)
  folderType?: FolderType;

  @IsOptional()
  @IsString()
  semester?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  weekNumber?: number;

  @IsOptional()
  @IsString()
  theme?: string;

  @IsOptional()
  @Type(() => String)
  @IsString()
  @IsIn(RESOURCE_STATUSES)
  status?: ResourceStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsString()
  keyword?: string;
}

export class MyResourceListQueryDto {
  @IsOptional()
  @Type(() => String)
  @IsString()
  @IsIn(RESOURCE_STATUSES)
  status?: ResourceStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class CreateResourceDto implements CreateResourceRequest {
  @IsNotEmpty()
  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  titleEn?: string;

  @IsNotEmpty()
  @Type(() => String)
  @IsString()
  @IsIn(PROGRAM_CODES)
  program!: ProgramCode;

  @IsNotEmpty()
  @IsString()
  subject!: string;

  @IsOptional()
  @IsString()
  subSubject?: string;

  @IsNotEmpty()
  @Type(() => String)
  @IsString()
  @IsIn(FOLDER_TYPES)
  folderType!: FolderType;

  @IsOptional()
  @IsString()
  semester?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  weekNumber?: number;

  @IsOptional()
  @IsString()
  theme?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  fileBucketId?: string;

  @IsOptional()
  @IsString()
  filePath?: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  fileSize?: number;

  @IsOptional()
  @IsString()
  fileType?: string;
}

export class UpdateResourceDto implements UpdateResourceRequest {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  titleEn?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => String)
  @IsString()
  @IsIn(RESOURCE_STATUSES)
  status?: ResourceStatus;

  @IsOptional()
  @IsString()
  semester?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  weekNumber?: number;

  @IsOptional()
  @IsString()
  theme?: string;

  @IsOptional()
  @IsString()
  fileBucketId?: string;

  @IsOptional()
  @IsString()
  filePath?: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  fileSize?: number;

  @IsOptional()
  @IsString()
  fileType?: string;
}

/**
 * Recycle-bin listing.
 *
 * There is deliberately NO `status`/`program`/`keyword` filter: the bin is a
 * short administrative list ordered by deletion time, and every extra filter is
 * another way to be surprised by what it returns. The route is gated by
 * `resource.restore`, so enumerating the bin is itself the privileged act.
 */
export class RecycleBinQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/**
 * Register (or replace) the file attached to a resource.
 *
 * The client uploads the bytes straight to platform storage, so this endpoint
 * receives METADATA plus the file's leading bytes (`head`, base64) for the
 * server-side validation boundary in `common/files/file-validation.ts`.
 *
 * `head` is REQUIRED on purpose: without bytes to inspect, "validate the upload"
 * would degrade to trusting the declared name and MIME type, which is exactly the
 * check this endpoint exists to perform. `sizeBytes` is required for the same
 * reason (the 0-byte and size-ceiling rules cannot be applied to a guess).
 */
export class RegisterFileDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  mimeType!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  sizeBytes!: number;

  /**
   * Base64 of the first bytes of the file (only the first 4096 bytes are used).
   * Sent as base64 because the body is JSON; the server decodes it and refuses
   * MAGIC_BYTES_MISSING rather than guessing when it is absent or malformed.
   */
  @IsNotEmpty()
  @IsString()
  @MaxLength(12000)
  head!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  fileBucketId!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  filePath!: string;
}

export class ResourceIdParamDto {
  @IsUUID()
  id!: string;
}
