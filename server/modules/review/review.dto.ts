import { IsString, IsIn, IsOptional, MaxLength } from 'class-validator';
import type { ReviewResourceRequest } from '@shared/api.interface';

export class ReviewResourceDto implements ReviewResourceRequest {
  @IsString()
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
