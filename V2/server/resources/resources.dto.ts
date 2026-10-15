import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  Matches,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'
import { Type } from 'class-transformer'
import { RESOURCE_STATUSES } from '../../shared/resource-status'

/** 单次批量软删除的上限。超过就拒绝整批，而不是悄悄截断。 */
export const MAX_BULK_DELETE = 100

/**
 * 批量**软**删除的入参。
 *
 * 只接受一批资源 ID。输入层面的错误在这一层全部挡掉（fail closed）：
 *   · 不是数组 / 空数组          → 400
 *   · 有条目不是 UUID v4         → 400（`each: true` 逐条校验）
 *   · 超过 `MAX_BULK_DELETE`     → 400（**不截断**：悄悄只删前 100 条
 *                                   会让调用方以为全删了）
 *
 * **重复 ID 不在这里拒绝**，而是交给 service 去重并在结果里如实说明 ——
 * "重复"是调用方自己就能修正的输入瑕疵，没必要让整批失败。
 */
export class BulkDeleteResourcesDto {
  @IsArray({ message: 'ids 必须是数组' })
  @ArrayNotEmpty({ message: '请至少选择一条资源' })
  @ArrayMaxSize(MAX_BULK_DELETE, { message: `单次最多删除 ${MAX_BULK_DELETE} 条资源` })
  @IsUUID('4', { each: true, message: '资源 ID 不合法' })
  ids!: string[]
}

export class CreateResourceDto {
  /**
   * 必填。业主的硬要求：「系统已经知道 directoryId，教师不再选择班型/科目/目录」。
   * 界面上这个值来自"教师当前所在的目录"，不是让老师从下拉里挑。
   */
  @IsUUID('4', { message: '缺少所属目录' })
  directoryId!: string

  @IsString()
  @MinLength(1, { message: '请输入标题' })
  @MaxLength(200)
  title!: string

  @IsOptional()
  @IsString()
  @MaxLength(200)
  titleEn?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null
}

export class UpdateResourceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string

  @IsOptional()
  @IsString()
  @MaxLength(200)
  titleEn?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null

  @IsOptional()
  @IsUUID('4')
  directoryId?: string | null
}

export class ReviewQueueDto {
  /** 只看某个目录（含子树）下的待审资源。 */
  @IsOptional()
  @IsUUID('4')
  directoryId?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string

  /** 排序白名单；不传就是"最近更新在前"。 */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sort?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number
}

export class RecallResourceDto {
  /** 撤回原因（可选）。给了就记进审核时间线，方便日后回答"为什么下架"。 */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string | null
}

export class ReviewResourceDto {
  /** 只有 approve / reject。撤回有独立接口 —— 审核操作不混用。 */
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject'

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string | null
}

export class ListResourcesDto {
  @IsOptional()
  @IsUUID('4')
  directoryId?: string

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeSubtree?: boolean

  @IsOptional()
  @IsIn(RESOURCE_STATUSES as unknown as string[])
  status?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string

  /** 只看自己的（「我的资源」在服务端也按此过滤，不只依赖前端传参）。 */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  onlyMine?: boolean

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number
}

export class RegisterFileDto {
  /**
   * 只传票据 id。
   *
   * WHY 不让客户端在这里"再声明一次" fileName / size / sha256：
   * 那样就有一个缺口 —— 服务端无法证明报上来的 sha256 就是上传时
   * 被存储层强制校验的那个值。申请上传地址时这些值已经写进票据与签名，
   * 登记时一律以票据为准（见 0002_storage.sql 的说明）。
   */
  @IsUUID('4', { message: '缺少上传票据' })
  uploadId!: string
}

export class UploadUrlDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255, { message: '文件名过长（超过 255 个字符）' })
  fileName!: string

  @IsOptional()
  @IsString()
  @MaxLength(150)
  mimeType?: string

  @Type(() => Number)
  @IsInt({ message: '文件大小必须是整数' })
  @Min(1, { message: '文件为空，无法上传' })
  size!: number

  /**
   * 客户端对**将要上传的字节**算出的 sha256（hex）。
   *
   * 它会被写进上传签名（S3 是已签名头，本地是 HMAC 令牌），
   * 于是"上传的字节与声明的哈希不一致"由**存储层**拒绝，对象根本不会落地。
   */
  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/, { message: 'sha256 必须是 64 位十六进制' })
  sha256!: string
}
