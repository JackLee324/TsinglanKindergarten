import {
  ArrayMaxSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'
import { PERMISSION_CODES, USER_ROLES } from '../../shared/permissions'

export class ListUsersDto {
  /** 服务端搜索：姓名或用户名（业主 §28）。 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  q?: string

  @IsOptional()
  @IsIn(USER_ROLES as unknown as string[])
  role?: string

  @IsOptional()
  @IsIn(['active', 'inactive'] as const)
  status?: string

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

export class PermissionGrantDto {
  @IsIn(PERMISSION_CODES as unknown as string[], { message: '未知的权限' })
  permission!: string

  /** null = 全平台；否则 = 该目录及其子树。 */
  @IsOptional()
  @IsUUID('4', { message: '开放范围必须是合法的目录' })
  directoryId?: string | null
}

export class SetPermissionsDto {
  /**
   * 整份替换，不是增量 —— 界面上勾选框提交的就是"最终结果"，
   * 增量接口会让"取消勾选"变成一次 DELETETE 的猜测。
   */
  @IsArray()
  @ArrayMaxSize(500, { message: '一次最多提交 500 条授权' })
  @ValidateNested({ each: true })
  @Type(() => PermissionGrantDto)
  permissions!: PermissionGrantDto[]
}

export class CreateUserDto {
  @IsString()
  @MinLength(1, { message: '请输入姓名' })
  @MaxLength(64)
  name!: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  nameEn?: string | null

  @IsString()
  @MinLength(3, { message: '用户名至少 3 个字符' })
  @MaxLength(64)
  username!: string

  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(200)
  password!: string

  @IsIn(USER_ROLES as unknown as string[])
  role!: string

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PermissionGrantDto)
  permissions?: PermissionGrantDto[]
}

export class UpdateUserDto {
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
  @IsIn(USER_ROLES as unknown as string[])
  role?: string

  @IsOptional()
  @IsBoolean()
  active?: boolean

  @IsOptional()
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(200)
  password?: string
}
