import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

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

  /** 排序值（同级内从小到大）。对所有节点开放，含来自 PDF 的系统节点。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-100000)
  @Max(100000)
  sortOrder?: number;

  /**
   * 启用 / 停用。停用的节点**从目录树上消失**（读路径按 enabled=true 过滤），
   * 因此这是"这一学期不开这门课"的表达方式；可随时重新启用。
   */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
