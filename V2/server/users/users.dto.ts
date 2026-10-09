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

  /**
   * 建好后是否立即启用。**由后端在同一个事务里落库**（业主 Stage 13 §5）。
   *
   * WHY 必须有这个字段：界面原先的做法是"先建、再按用户名搜一次、再发第二个请求停用" ——
   * 两步不是原子的：第二步失败就会留下一个**意外启用**的账号；
   * 而且"按用户名搜一条"还可能命中别的账号（模糊搜索）。默认 true。
   */
  @IsOptional()
  @IsBoolean()
  active?: boolean

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

  /**
   * 改用户名（业主 Stage 13 §5）。唯一性由 `users_username_key`（lower(username) 唯一索引）
   * 在数据库层保证，服务层再给一次可读的 409 —— 并发下也不会出现两个同名账号。
   */
  @IsOptional()
  @IsString()
  @MinLength(3, { message: '用户名至少 3 个字符' })
  @MaxLength(64)
  username?: string

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
