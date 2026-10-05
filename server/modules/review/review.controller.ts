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
import { AuthorizationService } from '@server/modules/authz/authorization.service';

@Controller('api')
export class ReviewController {
  constructor(
    private readonly reviewService: ReviewService,
    private readonly authorization: AuthorizationService,
  ) {}

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
  async reviewResource(
    @CurrentTeacher() teacher: { id: string; name: string },
    @Param('id') id: string,
    @Body() dto: ReviewResourceDto,
  ): Promise<Resource> {
    // §7：审核动作**不再**只要求 `review.view`。
    //
    // 以前这里挂的是 @RequirePermission('review.view')，于是"能看待审核队列"就等于"能发布"，
    // 而 `review.approve` / `review.reject` 这两个已定义、且已授予 principal 与
    // curriculum_director 的权限，**在全仓从未被任何代码要求过** —— 幽灵权限。
    //
    // 影响范围要说准：内置角色里只有 principal / curriculum_director 持有 review.*，而它们
    // 三个权限都有，所以对内置角色本改动不改变行为。真正可被利用的是**按账号授权**
    // （permission.grant / account_permission_overrides）：管理员一旦给某位老师单独授予
    // 「查看待审核」，那位老师此前即可直接审核通过并发布。这条路径现在被堵上了。
    //
    // require() 不带 target：review.* 是 dataScoped，但作用域由下游 service 结合
    // subject_permissions 施加（见 AuthorizationService.can 的注释），这里只判定"是否持有该权限"。
    const authz = await this.authorization.getEffectivePermissions(teacher.id);
    this.authorization.require(authz, dto.action === 'approve' ? 'review.approve' : 'review.reject');

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
