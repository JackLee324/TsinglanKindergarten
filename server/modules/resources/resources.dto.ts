import {
  IsString,
  IsOptional,
  IsIn,
  IsNumber,
  Min,
  Max,
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

export class ResourceIdParamDto {
  @IsUUID()
  id!: string;
}
