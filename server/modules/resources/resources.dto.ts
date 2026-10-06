import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
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

  /**
   * legacy 资料夹分类。**上传时不再要求老师填**（§7）。
   *
   * 保留这个可选字段只有两个用途：
   *   1. 迁移期间脚本/接口显式写入历史分类；
   *   2. 万一某个目录无法自动推导（例如挂到一棵不含官方资料夹的树上），
   *      调用方可以显式给出，而不是让服务端**猜**一个值。
   * 常规上传走 `directoryId`，服务端自动维护这一列。
   */
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
   * 目录归属（可编辑目录树节点 id）。**新建时必填**（§8）。
   *
   * 「没有 directoryId → 不能提交保存」是业主的硬要求：资源必须落在目录树上，
   * 否则就会出现"库里有这条资源、但老师在目录里怎么点都找不到它"。
   * 历史数据允许 `directory_id IS NULL`（迁移报告如实统计，不假装对齐），
   * 管理员用 `/admin/unassigned-resources` 批量补；**新建不再产生新的 NULL**。
   *
   * 只做形状校验（UUID）；**存在性、是否启用、是否叶节点、以及调用方对该目录的
   * program/subject scope 一律在服务层判** —— 那需要查库和权限上下文，DTO 拿不到。
   */
  @IsUUID('4', { message: '必须选择所属目录（directoryId 缺失或不是合法 id）' })
  directoryId!: string;
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

/**
 * §8 待补齐资源列表的查询参数。
 *
 * `mode` 三态而不是一个布尔：`unassigned`（完全没归属）与 `subject_level`
 * （只在科目层）是**两种不同的编辑工作**，管理员通常一次只做一种。
 * 默认 `all` 只是为了让"我到底还有多少条没弄干净"这个总问题有答案。
 */
export class UnderFiledQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['all', 'unassigned', 'subject_level'])
  mode?: 'all' | 'unassigned' | 'subject_level';

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
 * §8 批量归档。
 *
 * `resourceIds` 有上限（200）：这不是性能优化，是**事故面控制** ——
 * 一次误操作最多影响 200 条，而且响应体里会逐个报告失败原因。
 */
export class AssignDirectoryDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  resourceIds!: string[];

  @IsUUID('4')
  directoryId!: string;

  /**
   * 是否同时把 legacy `folder_type` 改成从目标目录推导出的值。
   *
   * **默认 false**，因为 §9 明确要求不篡改历史分类。需要统一口径时
   * 由管理员显式开启，并且仅在能**确定推导**出值时才会写。
   */
  @IsOptional()
  @IsBoolean()
  syncLegacyFolderType?: boolean;
}
