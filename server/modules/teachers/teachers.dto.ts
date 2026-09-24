import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  CreateTeacherRequest,
  ProgramCode,
  RoleCode,
  SubjectPermissionInput,
  UpdateTeacherRequest,
} from '@shared/api.interface';

const ROLE_CODES: RoleCode[] = [
  'principal',
  'curriculum_director',
  'prek_head',
  'k_head',
  'pe_specialist',
  'prek_assistant',
  'k_assistant',
  'visitor',
];

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
