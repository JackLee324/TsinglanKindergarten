import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { resources, reviewRecords, teachers } from '@server/database/schema';
import { eq, desc, count, inArray } from 'drizzle-orm';
import type { Resource, ReviewRecord, ResourceListResponse, FolderType, ResourceStatus, ProgramCode } from '@shared/api.interface';
import { AuditLoggerService } from '../audit/audit-logger.service';

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditLogger: AuditLoggerService,
  ) {}

  async getPendingResources(page: number, pageSize: number): Promise<ResourceListResponse> {
    const offset = (page - 1) * pageSize;

    try {
      const [totalResult, items] = await Promise.all([
        this.db
          .select({ count: count() })
          .from(resources)
          .where(eq(resources.status, 'pending_review')),
        this.db
          .select()
          .from(resources)
          .where(eq(resources.status, 'pending_review'))
          .orderBy(desc(resources.createdAt))
          .limit(pageSize)
          .offset(offset),
      ]);

      const total = totalResult[0]?.count ?? 0;

      // 获取上传者姓名
      const uploaderIds = [...new Set(items.map((item) => item.uploaderId))];
      let teacherMap = new Map<string, typeof teachers.$inferSelect>();
      if (uploaderIds.length > 0) {
        const teacherRows = await this.db
          .select()
          .from(teachers)
          .where(inArray(teachers.id, uploaderIds));
        teacherMap = new Map(teacherRows.map((t) => [t.id, t]));
      }

      return {
        items: items.map((item) => this.mapToResource(item, teacherMap)),
        total,
        page,
        pageSize,
      };
    } catch (error) {
      this.logger.error('获取待审核资源失败', error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  async reviewResource(
    resourceId: string,
    action: 'approve' | 'reject',
    comment: string | undefined,
    reviewerId: string,
    reviewerName: string,
  ): Promise<Resource> {
    try {
      return await this.db.transaction(async (tx) => {
        // 检查资源是否存在且状态为待审核
        const existing = await tx
          .select()
          .from(resources)
          .where(eq(resources.id, resourceId));

        if (existing.length === 0) {
          throw new NotFoundException('资源不存在');
        }

        const resource = existing[0];
        if (resource.status !== 'pending_review') {
          throw new BadRequestException('只有待审核状态的资源可以执行审核操作');
        }

        const newStatus = action === 'approve' ? 'published' : 'rejected';
        const now = new Date();

        const updated = await tx
          .update(resources)
          .set({
            status: newStatus,
            reviewerId,
            reviewComment: comment ?? null,
            reviewedAt: now,
          })
          .where(eq(resources.id, resourceId))
          .returning();

        if (updated.length === 0) {
          throw new NotFoundException('资源不存在');
        }

        // 插入审核记录
        await tx.insert(reviewRecords).values({
          resourceId,
          reviewerId,
          action,
          comment: comment ?? null,
        });

        // 记录审计日志
        const auditAction = action === 'approve' ? 'resource_approve' : 'resource_reject';
        await this.auditLogger.log(auditAction, {
          teacherId: reviewerId,
          teacherName: reviewerName,
          resourceId,
          resourceTitle: resource.title,
          program: resource.program,
          subject: resource.subject,
          detail: comment ? `审核意见：${comment}` : undefined,
          success: true,
        });

        // 获取上传者姓名
        const uploader = await tx
          .select()
          .from(teachers)
          .where(eq(teachers.id, updated[0].uploaderId));

        const teacherMap = new Map<string, typeof teachers.$inferSelect>();
        if (uploader.length > 0) {
          teacherMap.set(uploader[0].id, uploader[0]);
        }

        return this.mapToResource(updated[0], teacherMap);
      });
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`审核资源失败: ${resourceId}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  async getReviewHistory(resourceId: string): Promise<ReviewRecord[]> {
    try {
      // 检查资源是否存在
      const resourceExists = await this.db
        .select({ id: resources.id })
        .from(resources)
        .where(eq(resources.id, resourceId));

      if (resourceExists.length === 0) {
        throw new NotFoundException('资源不存在');
      }

      const records = await this.db
        .select()
        .from(reviewRecords)
        .where(eq(reviewRecords.resourceId, resourceId))
        .orderBy(desc(reviewRecords.createdAt));

      // 获取审核人姓名
      const reviewerIds = [...new Set(records.map((r) => r.reviewerId))];
      let reviewerMap = new Map<string, string>();
      if (reviewerIds.length > 0) {
        const reviewers = await this.db
          .select()
          .from(teachers)
          .where(inArray(teachers.id, reviewerIds));
        reviewerMap = new Map(reviewers.map((t) => [t.id, t.name]));
      }

      return records.map((record) => ({
        id: record.id,
        resourceId: record.resourceId,
        reviewerId: record.reviewerId,
        reviewerName: reviewerMap.get(record.reviewerId) ?? '未知',
        action: record.action as 'approve' | 'reject',
        comment: record.comment ?? undefined,
        createdAt: record.createdAt.toISOString(),
      }));
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`获取审核历史失败: ${resourceId}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  private mapToResource(
    row: typeof resources.$inferSelect,
    teacherMap: Map<string, typeof teachers.$inferSelect>,
  ): Resource {
    const uploader = teacherMap.get(row.uploaderId);
    const reviewer = row.reviewerId ? teacherMap.get(row.reviewerId) : undefined;

    return {
      id: row.id,
      title: row.title,
      titleEn: row.titleEn ?? undefined,
      program: row.program as ProgramCode,
      subject: row.subject,
      subSubject: row.subSubject ?? undefined,
      folderType: row.folderType as FolderType,
      semester: row.semester ?? undefined,
      weekNumber: row.weekNumber ?? undefined,
      theme: row.theme ?? undefined,
      description: row.description ?? undefined,
      fileName: row.fileName ?? undefined,
      fileSize: row.fileSize ?? undefined,
      fileType: row.fileType ?? undefined,
      version: row.version,
      status: row.status as ResourceStatus,
      uploaderId: row.uploaderId,
      uploaderName: uploader?.name ?? '未知教师',
      reviewerId: row.reviewerId ?? undefined,
      reviewerName: reviewer?.name ?? undefined,
      reviewComment: row.reviewComment ?? undefined,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
