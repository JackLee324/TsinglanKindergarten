import { ValidateIf, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import type {
  ProgramCode,
  FolderType,
  ResourceStatus,
  CreateResourceRequest,
  UpdateResourceRequest,
  ResourceListParams,
} from '@shared/api.interface';
// The program / folder vocabularies come from the canonical module, NEVER from a
// local array. This file used to declare its own `PROGRAM_CODES` and
// `FOLDER_TYPES` literals — two more copies of tokens that also lived in
// shared/api.interface.ts and curriculum.data.ts. A local copy cannot be checked
// against the others, which is how the naming drift started.
import { FOLDER_TYPES, PROGRAM_CODES } from '@shared/curriculum';

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

  /** 只看归属在该目录（含子孙）下的资源，值是目录 code。见 ResourceListParams。 */
  @IsOptional()
  @IsString()
  directory?: string;

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

  /**
   * 目录归属（可编辑目录树节点 id）。可选。
   * 只做形状校验（UUID）；**存在性、是否启用、以及调用方对该目录的 scope
   * 一律在服务层判** —— 那需要查库和权限上下文，DTO 层拿不到。
   */
  @IsOptional()
  @IsUUID()
  directoryId?: string;
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

  /**
   * 新目录归属。三态：
   *   · 不传（undefined） = 不改动现有归属；
   *   · 传 null           = 解除归属（留空）；
   *   · 传 uuid           = 改到该目录。
   * 用 `@ValidateIf` 而不是 `@IsOptional()`：后者会连同 null 一起放行，
   * 虽然结果相同，但意图不清晰；这里明确"只有 null/undefined 例外，其余必须是 UUID"。
   */
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID()
  directoryId?: string | null;

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

/**
 * 申请一个客户端直传地址。
 *
 * 只接受**文件名**：对象键由服务端生成（`uploads/<resourceId>/<时间戳>-<名字>`）。
 * 让客户端指定键就等于让它能覆盖任意对象 —— 那不是上传，是任意写。
 * 文件名在这里只用于拼键与后续登记时的清洗，不会被当作路径。
 */
export class CreateUploadUrlDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;
}

/**
 * 按需永久删除（purge）的请求体。
 *
 * `reason` 是**必填**的：这条操作不可逆，而审计记录里必须能回答
 * "谁、什么时候、为什么把一个资源永久删掉了"。没有理由的永久删除
 * 事后无法复核 —— 那种记录等于没记。
 */
export class PurgeResourceDto {
  @IsString()
  @MinLength(4, { message: '必须写明清理原因（至少 4 个字）' })
  @MaxLength(500)
  reason!: string;
}
