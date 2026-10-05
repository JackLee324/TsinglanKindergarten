import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 目录写操作的 DTO。
 *
 * 与项目其余 DTO 同一套约定：请求体里**未声明**的字段会被全局 ValidationPipe
 * （`whitelist: true`）丢掉，所以这里声明什么，服务层就能收到什么。
 */

export class CreateDirectoryFolderDto {
  /** 父节点 code，例如 `prek:pe_lesson`。 */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  parentCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class UpdateDirectoryNodeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
