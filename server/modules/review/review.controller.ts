import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ReviewService } from './review.service';
import { ReviewResourceDto } from './review.dto';
import type {
  ResourceListResponse,
  ReviewRecord,
  Resource,
} from '@shared/api.interface';
import { CurrentTeacher } from '@server/modules/auth/auth.guard';
import { RequirePermission } from '@server/modules/authz/permission.decorator';

@Controller('api')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Get('review/pending')
  @RequirePermission('review.view')
  async getPendingResources(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<ResourceListResponse> {
    const pageNum = page ? parseInt(page, 10) : 1;
    const pageSizeNum = pageSize ? parseInt(pageSize, 10) : 20;

    return this.reviewService.getPendingResources(pageNum, pageSizeNum);
  }

  /**
   * Approve or reject a resource.
   *
   * Previously guarded by a single `canReview()` role test that treated approve
   * and reject identically. They are now separate permissions, so an
   * administrator can (for example) allow a reviewer to reject without allowing
   * publish, and the requirement is visible on the route.
   *
   * NOTE: `resource.publish_without_review` is intentionally NOT implied here —
   * approving through the review flow and bypassing the flow entirely are
   * different capabilities (RBAC.md §4).
   */
  @Post('resources/:id/review')
  @RequirePermission('review.view')
  async reviewResource(
    @CurrentTeacher() teacher: { id: string; name: string },
    @Param('id') id: string,
    @Body() dto: ReviewResourceDto,
  ): Promise<Resource> {
    return this.reviewService.reviewResource(
      id,
      dto.action,
      dto.comment,
      teacher.id,
      teacher.name,
    );
  }

  @Get('resources/:id/review-history')
  @RequirePermission('review.view')
  async getReviewHistory(
    @Param('id') id: string,
  ): Promise<ReviewRecord[]> {
    return this.reviewService.getReviewHistory(id);
  }
}
