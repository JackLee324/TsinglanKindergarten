import {
  Injectable,
  Inject,
  Logger,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  eq,
  and,
  count,
  desc,
  sql,
  gte,
} from 'drizzle-orm';
import {
  resources,
  teachers,
  subjectPermissions,
} from '@server/database/schema';
import type { RoleCode } from '@shared/api.interface';

const ADMIN_ROLES: RoleCode[] = ['principal', 'curriculum_director'];

export interface DashboardStatsResult {
  myResources: number;
  pendingReview: number;
  monthlyUpload: number;
  authorizedSubjects: number;
  myPublished: number;
  prekCount?: number;
  kCount?: number;
  coverCount?: number;
}

export interface RecentUpdateItem {
  id: string;
  title: string;
  titleEn: string | null;
  program: string;
  subject: string;
  subSubject: string | null;
  folderType: string;
  uploaderName: string;
  status: string;
  updatedAt: Date;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async getStats(teacherId: string): Promise<DashboardStatsResult> {
    // 查教师角色
    const teacherRows = await this.db
      .select({ roles: teachers.roles })
      .from(teachers)
      .where(eq(teachers.id, teacherId))
      .limit(1);

    const roles: string[] = teacherRows[0]?.roles ?? [];
    const isAdmin = ADMIN_ROLES.some((r: string) => roles.includes(r));

    // 我的资源总数
    const myRes = await this.db
      .select({ count: count() })
      .from(resources)
      .where(eq(resources.uploaderId, teacherId))
      .limit(1);
    const myResources = Number(myRes[0]?.count ?? 0);

    // 待审核数量：管理员看全部待审核，普通教师看自己提交的
    let pendingReview: number;
    if (isAdmin) {
      const pendingRes = await this.db
        .select({ count: count() })
        .from(resources)
        .where(eq(resources.status, 'pending_review'))
        .limit(1);
      pendingReview = Number(pendingRes[0]?.count ?? 0);
    } else {
      const pendingRes = await this.db
        .select({ count: count() })
        .from(resources)
        .where(
          and(
            eq(resources.uploaderId, teacherId),
            eq(resources.status, 'pending_review'),
          ),
        )
        .limit(1);
      pendingReview = Number(pendingRes[0]?.count ?? 0);
    }

    // 本月上传数量
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyRes = await this.db
      .select({ count: count() })
      .from(resources)
      .where(
        and(
          eq(resources.uploaderId, teacherId),
          gte(resources.createdAt, monthStart),
        ),
      )
      .limit(1);
    const monthlyUpload = Number(monthlyRes[0]?.count ?? 0);

    // 授权科目数：管理员全部科目，普通教师按角色+权限表
    let authorizedSubjects: number;
    if (isAdmin) {
      const distinctSubj = await this.db
        .select({
          program: resources.program,
          subject: resources.subject,
        })
        .from(resources)
        .groupBy(resources.program, resources.subject);
      authorizedSubjects = distinctSubj.length;
    } else {
      // 角色级授权科目
      const roleSubjects = new Set<string>();

      const hasPrekHead = roles.includes('prek_head');
      const hasKHead = roles.includes('k_head');
      const hasPeSpecialist = roles.includes('pe_specialist');

      if (hasPrekHead) {
        const prekSubj = await this.db
          .select({ subject: resources.subject })
          .from(resources)
          .where(eq(resources.program, 'prek'))
          .groupBy(resources.subject);
        for (const s of prekSubj) roleSubjects.add(`prek:${s.subject}`);
      }

      if (hasKHead) {
        const kSubj = await this.db
          .select({ subject: resources.subject })
          .from(resources)
          .where(eq(resources.program, 'k'))
          .groupBy(resources.subject);
        for (const s of kSubj) roleSubjects.add(`k:${s.subject}`);
      }

      if (hasPeSpecialist) {
        roleSubjects.add('prek:physical_education');
        roleSubjects.add('k:physical_education');
      }

      // subject_permissions 表中的权限
      const permRows = await this.db
        .select({
          program: subjectPermissions.program,
          subject: subjectPermissions.subject,
        })
        .from(subjectPermissions)
        .where(
          and(
            eq(subjectPermissions.teacherId, teacherId),
            eq(subjectPermissions.canView, true),
          ),
        );
      for (const p of permRows) {
        roleSubjects.add(`${p.program}:${p.subject}`);
      }

      authorizedSubjects = roleSubjects.size;
    }

    // 我已发布的资源数
    const publishedRes = await this.db
      .select({ count: count() })
      .from(resources)
      .where(
        and(
          eq(resources.uploaderId, teacherId),
          eq(resources.status, 'published'),
        ),
      )
      .limit(1);
    const myPublished = Number(publishedRes[0]?.count ?? 0);

    const result: DashboardStatsResult = {
      myResources,
      pendingReview,
      monthlyUpload,
      authorizedSubjects,
      myPublished,
    };

    if (isAdmin) {
      const prekCountRes = await this.db
        .select({ count: count() })
        .from(resources)
        .where(
          and(eq(resources.program, 'prek'), eq(resources.status, 'published')),
        )
        .limit(1);
      result.prekCount = Number(prekCountRes[0]?.count ?? 0);

      const kCountRes = await this.db
        .select({ count: count() })
        .from(resources)
        .where(
          and(eq(resources.program, 'k'), eq(resources.status, 'published')),
        )
        .limit(1);
      result.kCount = Number(kCountRes[0]?.count ?? 0);

      const coverCountRes = await this.db
        .select({ count: count() })
        .from(resources)
        .where(
          and(
            eq(resources.folderType, 'courseware'),
            eq(resources.status, 'published'),
          ),
        )
        .limit(1);
      result.coverCount = Number(coverCountRes[0]?.count ?? 0);
    }

    return result;
  }

  async getRecentUpdates(
    teacherId: string,
    limit: number,
  ): Promise<{ items: RecentUpdateItem[]; total: number }> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);

    // 查教师角色
    const teacherRows = await this.db
      .select({ roles: teachers.roles })
      .from(teachers)
      .where(eq(teachers.id, teacherId))
      .limit(1);
    const roles: string[] = teacherRows[0]?.roles ?? [];
    const isAdmin = ADMIN_ROLES.some((r: string) => roles.includes(r));

    const whereConditions = [];
    if (isAdmin) {
      // 管理员：看所有最新更新
    } else {
      // 普通教师：看已发布的 + 自己的
      whereConditions.push(
        sql`(${resources.status} = ${'published'} OR ${resources.uploaderId} = ${teacherId})`,
      );
    }

    const whereClause = whereConditions.length > 0
      ? and(...whereConditions)
      : undefined;

    const rows = await this.db
      .select({
        id: resources.id,
        title: resources.title,
        titleEn: resources.titleEn,
        program: resources.program,
        subject: resources.subject,
        subSubject: resources.subSubject,
        folderType: resources.folderType,
        uploaderName: sql<string>`${teachers.name}`,
        status: resources.status,
        updatedAt: resources.updatedAt,
      })
      .from(resources)
      .leftJoin(teachers, eq(resources.uploaderId, teachers.id))
      .where(whereClause)
      .orderBy(desc(resources.updatedAt))
      .limit(safeLimit);

    const countRes = await this.db
      .select({ count: count() })
      .from(resources)
      .where(whereClause)
      .limit(1);

    return {
      items: rows as RecentUpdateItem[],
      total: Number(countRes[0]?.count ?? 0),
    };
  }
}
