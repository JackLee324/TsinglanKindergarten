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
import { DIRECTORY_TYPES } from '../../shared/directory'

export class CreateDirectoryDto {
  /** null / 省略 = **新增一级栏目**（业主的核心验收场景）。 */
  @IsOptional()
  @IsUUID('4', { message: '父目录不合法' })
  parentId?: string | null

  @IsString()
  @MinLength(1, { message: '请输入名称' })
  @MaxLength(64)
  name!: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  nameEn?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null

  /** 中文名生成不出可读地址，所以一级栏目通常要显式给 slug。 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  slug?: string

  @IsOptional()
  @IsIn(DIRECTORY_TYPES as unknown as string[])
  type?: string

  @IsOptional()
  @IsBoolean()
  allowChildren?: boolean

  @IsOptional()
  @IsBoolean()
  allowFiles?: boolean

  @IsOptional()
  @IsBoolean()
  allowCustomFolders?: boolean
}

export class UpdateDirectoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  nameEn?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null

  @IsOptional()
  @IsIn(DIRECTORY_TYPES as unknown as string[])
  type?: string

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number

  @IsOptional()
  @IsBoolean()
  enabled?: boolean

  @IsOptional()
  @IsBoolean()
  allowChildren?: boolean

  @IsOptional()
  @IsBoolean()
  allowFiles?: boolean

  @IsOptional()
  @IsBoolean()
  allowCustomFolders?: boolean

  @IsOptional()
  @IsString()
  @MaxLength(64)
  icon?: string | null
}

export class MoveDirectoryDto {
  @IsOptional()
  @IsUUID('4', { message: '目标父目录不合法' })
  parentId?: string | null
}

export class ReorderDirectoryDto {
  @IsIn(['up', 'down'])
  direction!: 'up' | 'down'
}

export class CreateFolderDto {
  @IsUUID('4', { message: '父目录不合法' })
  parentId!: string

  @IsString()
  @MinLength(1, { message: '请输入文件夹名称' })
  @MaxLength(64)
  name!: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  nameEn?: string | null
}
