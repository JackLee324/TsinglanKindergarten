import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type {
  CreateTeacherRequest,
  ProgramCode,
  RoleCode,
  SubjectPermissionInput,
  UpdateTeacherRequest,
} from '@shared/api.interface';
import { ROLE_CODES as SHARED_ROLE_CODES } from '@shared/rbac';

// §10：角色表只有一份，在 shared/rbac.ts。这里以前自己抄了一份 8 个角色的列表，
// **漏掉 super_admin** —— 于是 DTO 直接拒绝了 super_admin，API 永远无法创建/授予它。
//
// 更糟的是它顺手"挡住"了提权：`principal 把自己人提成 super_admin` 返回的是这里的 400，
// 而不是 RBAC 的 403。也就是说那条安全断言一直在**因为错误的原因通过**。
// 角色**形状**（是不是已知角色）归 DTO，角色**授予权限**归 AuthorizationService ——
// 两侧各司其职，见 teachers.service.ts 的 createTeacher/updateTeacher。
const ROLE_CODES: RoleCode[] = SHARED_ROLE_CODES;

const PROGRAM_CODES: ProgramCode[] = ['prek', 'k'];

export class ListTeachersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @Type(() => String)
  @IsString()
  @IsIn(ROLE_CODES)
  role?: RoleCode;

  @IsOptional()
  @Type(() => String)
  @IsString()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

export class SubjectPermissionInputDto implements SubjectPermissionInput {
  @Type(() => String)
  @IsString()
  @IsIn(PROGRAM_CODES)
  program!: ProgramCode;

  @IsString()
  subject!: string;

  @IsOptional()
  @IsString()
  subSubject?: string;

  @IsBoolean()
  canView!: boolean;

  @IsBoolean()
  canUpload!: boolean;
}

export class CreateTeacherDto implements CreateTeacherRequest {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  wecomUserId?: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  nameEn?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsArray()
  @Type(() => String)
  @IsString({ each: true })
  @IsIn(ROLE_CODES, { each: true })
  roles!: RoleCode[];

  @IsOptional()
  @Type(() => String)
  @IsString()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubjectPermissionInputDto)
  permissions?: SubjectPermissionInputDto[];
}

export class UpdateTeacherDto implements UpdateTeacherRequest {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  nameEn?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsArray()
  @Type(() => String)
  @IsString({ each: true })
  @IsIn(ROLE_CODES, { each: true })
  roles?: RoleCode[];

  @IsOptional()
  @Type(() => String)
  @IsString()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

export class UpdatePermissionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubjectPermissionInputDto)
  permissions!: SubjectPermissionInputDto[];
}

/**
 * §11 按账号授权：追加授权 / 显式禁止。
 *
 * `permission` 用字符串而不是 `PermissionCode` 联合：DTO 层的校验只能保证"是个字符串"，
 * **是否属于权限目录**由服务层用 `isKnownPermission()` 判定 —— 那条判定在
 * `AuthorizationService.setPermissionOverride` 里，是唯一的真相，
 * 在这里再抄一份白名单只会变成第二个会漂移的副本（这个项目已经吃过这个亏）。
 */
export class PermissionOverrideDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  permission!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
