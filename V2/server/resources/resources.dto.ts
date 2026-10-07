import {
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
