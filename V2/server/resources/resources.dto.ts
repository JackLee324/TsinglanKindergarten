import {
  IsBoolean,
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
  @IsString()
  @MinLength(1)
  storageKey!: string

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string

  @IsString()
  @MinLength(1)
  @MaxLength(150)
  mimeType!: string

  @Type(() => Number)
  @IsInt()
  @Min(0)
  size!: number

  @IsString()
  @MinLength(64)
  @MaxLength(64)
  sha256!: string
}

export class UploadUrlDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string

  @IsString()
  @MinLength(1)
  @MaxLength(150)
  mimeType!: string

  @Type(() => Number)
  @IsInt()
  @Min(0)
  size!: number
}
