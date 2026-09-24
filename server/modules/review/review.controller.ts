import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import { ReviewService } from './review.service';
import { ReviewResourceDto } from './review.dto';
import type {
  ResourceListResponse,
  ReviewRecord,
  Resource,
  RoleCode,
} from '@shared/api.interface';
import { CurrentTeacher } from '@server/modules/auth/auth.guard';

@Controller('api')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  private canReview(roles: RoleCode[]): boolean {
    return (
      roles.includes('curriculum_director') || roles.includes('principal')
    );
  }

  @Get('review/pending')
  async getPendingResources(
    @CurrentTeacher() teacher: { id: string; roles: RoleCode[] },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<ResourceListResponse> {
    if (!this.canReview(teacher.roles)) {
      throw new ForbiddenException('您没有审核权限');
    }

    const pageNum = page ? parseInt(page, 10) : 1;
    const pageSizeNum = pageSize ? parseInt(pageSize, 10) : 20;

    return this.reviewService.getPendingResources(pageNum, pageSizeNum);
  }

  @Post('resources/:id/review')
  async reviewResource(
    @CurrentTeacher() teacher: {
      id: string;
      name: string;
      roles: RoleCode[];
    },
    @Param('id') id: string,
    @Body() dto: ReviewResourceDto,
  ): Promise<Resource> {
    if (!this.canReview(teacher.roles)) {
      throw new ForbiddenException('您没有审核权限');
    }

    return this.reviewService.reviewResource(
      id,
      dto.action,
      dto.comment,
      teacher.id,
      teacher.name,
    );
  }

  @Get('resources/:id/review-history')
  async getReviewHistory(
    @CurrentTeacher() _teacher: { id: string; roles: RoleCode[] },
    @Param('id') id: string,
  ): Promise<ReviewRecord[]> {
    return this.reviewService.getReviewHistory(id);
  }
}
