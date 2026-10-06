import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
import { SCOPE_KINDS } from '@shared/rbac';
import type { ScopeKind } from '@shared/rbac';
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

/**
 * §12 一条数据范围绑定（写模型）。
 *
 * `kind` 用 `@IsIn(['ALL','PROGRAM','SUBJECT','OWN'])` 而不是 `@IsEnum`：
 * 这四个值是 `shared/rbac.ts` 里的 `ScopeKind` 联合类型，不是 TS enum ——
 * 枚举字面量在这里会变成**第二份真相**。用数组常量，且引用同一处定义。
 */
export class ScopeBindingDto {
  /**
   * 该绑定作用于哪个权限；省略 = 对该账号的**所有数据权限**生效。
   * 值必须是权限目录里的真实权限码，由服务层用 `isKnownPermission` 校验。
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  permission?: string | null;

  @IsIn(SCOPE_KINDS)
  kind!: ScopeKind;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  program?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  subject?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  subSubject?: string | null;
}

/**
 * §12 整表替换数据范围。
 *
 * `scopes` **必传**（哪怕是空数组）：省略与"清空"必须能区分 ——
 * 允许省略的话，一次忘记带字段的请求会静默把人的数据范围放大到角色默认，
 * 而那是**扩大权限**的方向，不能靠"调用方大概会传"来兜底。
 */
export class SetScopesDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ScopeBindingDto)
  scopes!: ScopeBindingDto[];
}
