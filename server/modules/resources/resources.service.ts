import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { createReadStream } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';
import {
  DRIZZLE_DATABASE,
  FileService,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  eq,
  and,
  count,
  desc,
  ilike,
  or,
  inArray,
  isNull,
  gte,
  sql,
} from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import type {
  Resource,
  ResourceListResponse,
  ResourceListParams,
  CreateResourceRequest,
  UpdateResourceRequest,
  AuditAction,
  RoleCode,
  ProgramCode,
} from '@shared/api.interface';
import {
  resources,
  teachers,
  subjectPermissions,
  auditLogs,
} from '@server/database/schema';

const ADMIN_ROLES: RoleCode[] = ['principal', 'curriculum_director'];

@Injectable()
export class ResourcesService {
  private readonly logger = new Logger(ResourcesService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly fileService: FileService,
  ) {}

  // ========== 辅助方法 ==========

  private async isAdminTeacher(teacherId: string): Promise<boolean> {
    const teacher = await this.getTeacherById(teacherId);
    if (!teacher) return false;
    return ADMIN_ROLES.some((r: string) => teacher.roles.includes(r));
  }

  // ========== 权限校验 ==========

  /**
   * 构建列表查询的科目权限过滤条件
   * 返回 null 表示无任何权限
   */
  private async buildPermissionCondition(
    teacherId: string,
    program: ProgramCode | undefined,
    subject: string | undefined,
    subSubject: string | undefined,
  ): Promise<SQLWrapper | null> {
    // 先查教师角色
    const teacherRows = await this.db
      .select({ roles: teachers.roles })
      .from(teachers)
      .where(eq(teachers.id, teacherId))
      .limit(1);

    if (teacherRows.length === 0) return null;
    const roles: string[] = teacherRows[0].roles ?? [];

    // 园长 / 教学主任：全部通过
    if (ADMIN_ROLES.some((r: string) => roles.includes(r))) {
      return sql`true`;
    }

    const hasPrekHead = roles.includes('prek_head');
    const hasKHead = roles.includes('k_head');
    const hasPeSpecialist = roles.includes('pe_specialist');

    // 如果指定了 program + subject，先检查角色级权限
    if (program && subject) {
      if (hasPrekHead && program === 'prek') return sql`true`;
      if (hasKHead && program === 'k') return sql`true`;
      if (hasPeSpecialist && subject === 'physical_education') return sql`true`;
      // 否则查 subject_permissions 表
      const hasPerm = await this.hasPermissionInDb(
        teacherId,
        program,
        subject,
        subSubject,
        'view',
      );
      return hasPerm ? sql`true` : null;
    }

    // 未指定具体科目：收集所有有权限的 (program, subject, sub_subject) 组合
    const permClauses: SQLWrapper[] = [];

    // prek_head 有 prek 全部科目权限
    if (hasPrekHead) {
      if (program === 'prek' || !program) {
        permClauses.push(eq(resources.program, 'prek'));
      }
    }

    // k_head 有 k 全部科目权限
    if (hasKHead) {
      if (program === 'k' || !program) {
        permClauses.push(eq(resources.program, 'k'));
      }
    }

    // pe_specialist 有体能科目权限
    if (hasPeSpecialist) {
      if (!program || program === 'prek' || program === 'k') {
        permClauses.push(eq(resources.subject, 'physical_education'));
      }
    }

    // 查 subject_permissions 表获取明细权限
    const permQueryConditions = [
      eq(subjectPermissions.teacherId, teacherId),
      eq(subjectPermissions.canView, true),
    ];
    if (program) {
      permQueryConditions.push(eq(subjectPermissions.program, program));
    }
    if (subject) {
      permQueryConditions.push(eq(subjectPermissions.subject, subject));
    }

    const permRows = await this.db
      .select({
        program: subjectPermissions.program,
        subject: subjectPermissions.subject,
        subSubject: subjectPermissions.subSubject,
      })
      .from(subjectPermissions)
      .where(and(...permQueryConditions));

    if (permRows.length > 0) {
      for (const perm of permRows) {
        if (perm.subSubject) {
          permClauses.push(
            and(
              eq(resources.program, perm.program),
              eq(resources.subject, perm.subject),
              eq(resources.subSubject, perm.subSubject),
            ),
          );
        } else {
          permClauses.push(
            and(
              eq(resources.program, perm.program),
              eq(resources.subject, perm.subject),
            ),
          );
        }
      }
    }

    if (permClauses.length === 0) return null;
    return or(...permClauses);
  }

  private async hasPermissionInDb(
    teacherId: string,
    program: string,
    subject: string,
    subSubject: string | undefined,
    action: 'view' | 'upload',
  ): Promise<boolean> {
    const conditions = [
      eq(subjectPermissions.teacherId, teacherId),
      eq(subjectPermissions.program, program),
      eq(subjectPermissions.subject, subject),
    ];

    if (subSubject) {
      conditions.push(eq(subjectPermissions.subSubject, subSubject));
    } else {
      conditions.push(isNull(subjectPermissions.subSubject));
    }

    const permRows = await this.db
      .select({
        canView: subjectPermissions.canView,
        canUpload: subjectPermissions.canUpload,
      })
      .from(subjectPermissions)
      .where(and(...conditions))
      .limit(1);

    if (permRows.length > 0) {
      return action === 'view'
        ? permRows[0].canView
        : permRows[0].canUpload;
    }

    // 查父科目（只配了 subject 没配 subSubject）
    if (subSubject) {
      const parentPerm = await this.db
        .select({
          canView: subjectPermissions.canView,
          canUpload: subjectPermissions.canUpload,
        })
        .from(subjectPermissions)
        .where(
          and(
            eq(subjectPermissions.teacherId, teacherId),
            eq(subjectPermissions.program, program),
            eq(subjectPermissions.subject, subject),
            isNull(subjectPermissions.subSubject),
          ),
        )
        .limit(1);

      if (parentPerm.length > 0) {
        return action === 'view'
          ? parentPerm[0].canView
          : parentPerm[0].canUpload;
      }
    }

    return false;
  }

  /**
   * 检查教师对指定科目的权限
   */
  async checkSubjectPermission(
    teacherId: string,
    program: ProgramCode,
    subject: string,
    subSubject: string | undefined,
    action: 'view' | 'upload',
  ): Promise<boolean> {
    try {
      // 查教师角色
      const teacherRows = await this.db
        .select({ roles: teachers.roles })
        .from(teachers)
        .where(eq(teachers.id, teacherId))
        .limit(1);

      if (teacherRows.length === 0) {
        return false;
      }

      const roles: string[] = teacherRows[0].roles ?? [];

      // 园长 / 教学主任：全部通过
      if (ADMIN_ROLES.some((r: string) => roles.includes(r))) {
        return true;
      }

      // prek_head：prek 所有科目有上传权限（view 自然也有）
      if (roles.includes('prek_head') && program === 'prek') {
        return true;
      }

      // k_head：k 所有科目有上传权限
      if (roles.includes('k_head') && program === 'k') {
        return true;
      }

      // pe_specialist：体能类科目有上传权限
      if (roles.includes('pe_specialist') && subject === 'physical_education') {
        return true;
      }

      // 其他角色查 subject_permissions 表
      const conditions = [
        eq(subjectPermissions.teacherId, teacherId),
        eq(subjectPermissions.program, program),
        eq(subjectPermissions.subject, subject),
      ];

      if (subSubject) {
        conditions.push(eq(subjectPermissions.subSubject, subSubject));
      } else {
        conditions.push(isNull(subjectPermissions.subSubject));
      }

      const permRows = await this.db
        .select({
          canView: subjectPermissions.canView,
          canUpload: subjectPermissions.canUpload,
        })
        .from(subjectPermissions)
        .where(and(...conditions))
        .limit(1);

      if (permRows.length === 0) {
        // 没配权限记录：尝试查父科目（只配了 subject 没配 subSubject 的情况）
        if (subSubject) {
          const parentPermRows = await this.db
            .select({
              canView: subjectPermissions.canView,
              canUpload: subjectPermissions.canUpload,
            })
            .from(subjectPermissions)
            .where(
              and(
                eq(subjectPermissions.teacherId, teacherId),
                eq(subjectPermissions.program, program),
                eq(subjectPermissions.subject, subject),
                isNull(subjectPermissions.subSubject),
              ),
            )
            .limit(1);

          if (parentPermRows.length > 0) {
            return action === 'view'
              ? parentPermRows[0].canView
              : parentPermRows[0].canUpload;
          }
        }
        return false;
      }

      return action === 'view'
        ? permRows[0].canView
        : permRows[0].canUpload;
    } catch (error) {
      this.logger.error(
        `checkSubjectPermission failed: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // ========== 审计日志 ==========

  private async logAudit(params: {
    action: AuditAction;
    teacherId?: string;
    teacherName?: string;
    wecomUserId?: string;
    ipAddress?: string;
    resourceId?: string;
    resourceTitle?: string;
    program?: string;
    subject?: string;
    success?: boolean;
    errorMessage?: string;
    detail?: string;
  }): Promise<void> {
    try {
      await this.db.insert(auditLogs).values({
        action: params.action,
        teacherId: params.teacherId,
        teacherName: params.teacherName,
        wecomUserId: params.wecomUserId,
        ipAddress: params.ipAddress,
        resourceId: params.resourceId,
        resourceTitle: params.resourceTitle,
        program: params.program,
        subject: params.subject,
        success: params.success ?? true,
        errorMessage: params.errorMessage,
        detail: params.detail,
      });
    } catch (error) {
      // 审计日志失败不阻塞主流程
      this.logger.error(
        `audit log failed: ${(error as Error).message}`,
      );
    }
  }

  // ========== 工具方法：获取教师信息 ==========

  private async getTeacherById(
    teacherId: string,
  ): Promise<{ id: string; name: string; roles: string[] } | null> {
    const rows = await this.db
      .select({
        id: teachers.id,
        name: teachers.name,
        roles: teachers.roles,
      })
      .from(teachers)
      .where(eq(teachers.id, teacherId))
      .limit(1);
    return rows[0] ?? null;
  }

  // ========== 资源列表 ==========

  /**
   * 分页查询资源列表
   * 默认只返回 published 状态，本人/管理员可看全部
   */
  async listResources(
    params: ResourceListParams & { keyword?: string },
    currentTeacherId: string,
    ip?: string,
  ): Promise<ResourceListResponse> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const isAdmin = await this.isAdminTeacher(currentTeacherId);

    const conditions = [];

    // 科目权限过滤：非管理员只能看有权限的科目
    if (!isAdmin) {
      const permConditions = await this.buildPermissionCondition(
        currentTeacherId,
        params.program as ProgramCode | undefined,
        params.subject,
        params.subSubject,
      );
      if (permConditions === null) {
        // 明确指定了科目但无权限：返回 403
        if (params.program && params.subject) {
          await this.logAudit({
            action: 'permission_denied',
            teacherId: currentTeacherId,
            program: params.program,
            subject: params.subject,
            success: false,
            errorMessage: '无科目查看权限',
            ipAddress: ip,
            detail: '列表查询被拒绝',
          });
          throw new ForbiddenException('无该科目查看权限');
        }
        // 未指定科目：返回空列表
        return { items: [], total: 0, page, pageSize };
      }
      conditions.push(permConditions);
      // 按请求参数过滤 program/subject/subSubject
      if (params.program) {
        conditions.push(eq(resources.program, params.program));
        if (params.subject) {
          conditions.push(eq(resources.subject, params.subject));
        }
        if (params.subSubject) {
          conditions.push(eq(resources.subSubject, params.subSubject));
        }
      }
    } else if (params.program) {
      conditions.push(eq(resources.program, params.program));
      if (params.subject) {
        conditions.push(eq(resources.subject, params.subject));
      }
      if (params.subSubject) {
        conditions.push(eq(resources.subSubject, params.subSubject));
      }
    }
    if (params.folderType) {
      conditions.push(eq(resources.folderType, params.folderType));
    }
    if (params.semester) {
      conditions.push(eq(resources.semester, params.semester));
    }
    if (params.weekNumber !== undefined) {
      conditions.push(eq(resources.weekNumber, params.weekNumber));
    }
    if (params.theme) {
      conditions.push(eq(resources.theme, params.theme));
    }

    // 状态过滤逻辑
    if (params.status) {
      // 显式指定了 status：管理员可以看所有状态
      // 普通教师：指定状态是自己的，或者指定 published 时所有人可见
      if (isAdmin) {
        conditions.push(eq(resources.status, params.status));
      } else if (params.status === 'published') {
        conditions.push(eq(resources.status, 'published'));
      } else {
        conditions.push(
          and(
            eq(resources.status, params.status),
            eq(resources.uploaderId, currentTeacherId),
          ),
        );
      }
    } else {
      // 未指定 status：默认返回 published + 自己的所有状态
      if (!isAdmin) {
        conditions.push(
          or(
            eq(resources.status, 'published'),
            eq(resources.uploaderId, currentTeacherId),
          ),
        );
      }
    }

    // 关键词搜索
    if (params.keyword) {
      const keyword = `%${params.keyword}%`;
      conditions.push(
        or(
          ilike(resources.title, keyword),
          ilike(resources.titleEn, keyword),
          ilike(resources.description, keyword),
        ),
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    try {
      // 总数
      const countResult = await this.db
        .select({ value: count() })
        .from(resources)
        .where(whereClause);
      const total = countResult[0]?.value ?? 0;

      // 列表：先查资源再批量查教师名
      const items = await this.db
        .select()
        .from(resources)
        .where(whereClause)
        .orderBy(desc(resources.createdAt))
        .limit(pageSize)
        .offset(offset);

      // 收集 uploader / reviewer ID 批量查
      const uploaderIds = new Set<string>();
      const reviewerIds = new Set<string>();
      for (const item of items) {
        if (item.uploaderId) uploaderIds.add(item.uploaderId);
        if (item.reviewerId) reviewerIds.add(item.reviewerId);
      }

      const teacherMap = new Map<string, string>();
      const allIds = [...new Set([...uploaderIds, ...reviewerIds])];
      if (allIds.length > 0) {
        const teacherRows = await this.db
          .select({ id: teachers.id, name: teachers.name })
          .from(teachers)
          .where(inArray(teachers.id, allIds));
        for (const t of teacherRows) {
          teacherMap.set(t.id, t.name);
        }
      }

      const resultItems: Resource[] = items.map((item) => ({
        id: item.id,
        title: item.title,
        titleEn: item.titleEn ?? undefined,
        program: item.program as ProgramCode,
        subject: item.subject,
        subSubject: item.subSubject ?? undefined,
        folderType: item.folderType as Resource['folderType'],
        semester: item.semester ?? undefined,
        weekNumber: item.weekNumber ?? undefined,
        theme: item.theme ?? undefined,
        description: item.description ?? undefined,
        fileName: item.fileName ?? undefined,
        fileSize: item.fileSize ?? undefined,
        fileType: item.fileType ?? undefined,
        version: item.version,
        status: item.status as Resource['status'],
        uploaderId: item.uploaderId,
        uploaderName: teacherMap.get(item.uploaderId) ?? '未知教师',
        reviewerId: item.reviewerId ?? undefined,
        reviewerName: item.reviewerId
          ? teacherMap.get(item.reviewerId)
          : undefined,
        reviewComment: item.reviewComment ?? undefined,
        reviewedAt: item.reviewedAt
          ? new Date(item.reviewedAt).toISOString()
          : undefined,
        createdAt: new Date(item.createdAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
      }));

      return {
        items: resultItems,
        total,
        page,
        pageSize,
      };
    } catch (error) {
      this.logger.error(`listResources failed: ${(error as Error).message}`);
      throw error;
    }
  }

  // ========== 公开只读方法（Guest 模式）==========

  async listPublicResources(
    params: ResourceListParams & { keyword?: string },
    ip?: string,
  ): Promise<ResourceListResponse> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const conditions = [];

    if (params.program) {
      conditions.push(eq(resources.program, params.program));
      if (params.subject) {
        conditions.push(eq(resources.subject, params.subject));
      }
      if (params.subSubject) {
        conditions.push(eq(resources.subSubject, params.subSubject));
      }
    }
    if (params.folderType) {
      conditions.push(eq(resources.folderType, params.folderType));
    }
    if (params.semester) {
      conditions.push(eq(resources.semester, params.semester));
    }
    if (params.weekNumber !== undefined) {
      conditions.push(eq(resources.weekNumber, params.weekNumber));
    }
    if (params.theme) {
      conditions.push(eq(resources.theme, params.theme));
    }

    conditions.push(eq(resources.status, 'published'));

    if (params.keyword) {
      const keyword = `%${params.keyword}%`;
      conditions.push(
        or(
          ilike(resources.title, keyword),
          ilike(resources.titleEn, keyword),
          ilike(resources.description, keyword),
        ),
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await this.db
      .select({ value: count() })
      .from(resources)
      .where(whereClause);
    const total = countResult[0]?.value ?? 0;

    const items = await this.db
      .select()
      .from(resources)
      .where(whereClause)
      .orderBy(desc(resources.createdAt))
      .limit(pageSize)
      .offset(offset);

    const uploaderIds = new Set<string>();
    for (const item of items) {
      if (item.uploaderId) uploaderIds.add(item.uploaderId);
    }

    const teacherMap = new Map<string, string>();
    if (uploaderIds.size > 0) {
      const teacherRows = await this.db
        .select({ id: teachers.id, name: teachers.name })
        .from(teachers)
        .where(inArray(teachers.id, [...uploaderIds]));
      for (const t of teacherRows) {
        teacherMap.set(t.id, t.name);
      }
    }

    const resultItems: Resource[] = items.map((item) => ({
      id: item.id,
      title: item.title,
      titleEn: item.titleEn ?? undefined,
      program: item.program as ProgramCode,
      subject: item.subject,
      subSubject: item.subSubject ?? undefined,
      folderType: item.folderType as Resource['folderType'],
      semester: item.semester ?? undefined,
      weekNumber: item.weekNumber ?? undefined,
      theme: item.theme ?? undefined,
      description: item.description ?? undefined,
      fileName: item.fileName ?? undefined,
      fileSize: item.fileSize ?? undefined,
      fileType: item.fileType ?? undefined,
      version: item.version,
      status: item.status as Resource['status'],
      uploaderId: item.uploaderId,
      uploaderName: teacherMap.get(item.uploaderId) ?? '未知教师',
      createdAt: new Date(item.createdAt).toISOString(),
      updatedAt: new Date(item.updatedAt).toISOString(),
    }));

    return { items: resultItems, total, page, pageSize };
  }

  async getPublicResource(
    id: string,
    ip?: string,
  ): Promise<Resource> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, id), eq(resources.status, 'published')))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const resource = rows[0];

    const teacherRows = await this.db
      .select({ id: teachers.id, name: teachers.name })
      .from(teachers)
      .where(eq(teachers.id, resource.uploaderId))
      .limit(1);
    const uploaderName = teacherRows[0]?.name ?? '未知教师';

    return {
      id: resource.id,
      title: resource.title,
      titleEn: resource.titleEn ?? undefined,
      program: resource.program as ProgramCode,
      subject: resource.subject,
      subSubject: resource.subSubject ?? undefined,
      folderType: resource.folderType as Resource['folderType'],
      semester: resource.semester ?? undefined,
      weekNumber: resource.weekNumber ?? undefined,
      theme: resource.theme ?? undefined,
      description: resource.description ?? undefined,
      fileName: resource.fileName ?? undefined,
      fileSize: resource.fileSize ?? undefined,
      fileType: resource.fileType ?? undefined,
      version: resource.version,
      status: resource.status as Resource['status'],
      uploaderId: resource.uploaderId,
      uploaderName,
      createdAt: new Date(resource.createdAt).toISOString(),
      updatedAt: new Date(resource.updatedAt).toISOString(),
    };
  }

  async getPublicDownloadUrl(
    id: string,
    ip?: string,
  ): Promise<{ downloadUrl: string; fileName: string }> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, id), eq(resources.status, 'published')))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const resource = rows[0];

    if (!resource.fileBucketId || !resource.filePath) {
      throw new NotFoundException('资源文件不存在');
    }

    const downloadUrl = `/api/__platform__/storage/download?bucket=${resource.fileBucketId}&path=${encodeURIComponent(resource.filePath)}`;

    return {
      downloadUrl,
      fileName: resource.fileName ?? 'download',
    };
  }

  async getPublicStorybookCoverStream(
    resourceId: string,
    index: number,
    ip?: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; fileName: string }> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, resourceId), eq(resources.status, 'published')))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const resource = rows[0];

    let weekData: { storybooks?: Array<{ filePath?: string; title?: string }> };
    try {
      weekData = resource.description ? JSON.parse(resource.description) : {};
    } catch {
      throw new BadRequestException('资源描述解析失败');
    }

    const storybooks = weekData.storybooks ?? [];
    if (index < 0 || index >= storybooks.length) {
      throw new NotFoundException('封面不存在');
    }

    const storybook = storybooks[index];
    const filePath = storybook?.filePath;
    if (!filePath) {
      throw new NotFoundException('封面文件路径不存在');
    }

    const fileName = filePath.split('/').pop() || `cover-${index}.jpg`;

    const possiblePaths = [
      join(__dirname, '../../../assets/prek-english-covers/', fileName),
      join(process.cwd(), 'server/assets/prek-english-covers/', fileName),
    ];

    let localPath: string | null = null;
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        localPath = p;
        break;
      }
    }

    if (!localPath) {
      throw new NotFoundException('封面文件不存在');
    }

    const safeFileName = storybook.title ? `${storybook.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg` : `cover-${index}.jpg`;
    const stream = createReadStream(localPath);

    return {
      stream,
      contentType: 'image/jpeg',
      fileName: safeFileName,
    };
  }

  // ========== 创建资源 ==========

  async getResource(
    id: string,
    currentTeacherId: string,
    ip?: string,
  ): Promise<Resource> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const resource = rows[0];
    const isAdmin = await this.isAdminTeacher(currentTeacherId);
    const isUploader = resource.uploaderId === currentTeacherId;

    // 非管理员且非上传者：只能看 published
    if (!isAdmin && !isUploader && resource.status !== 'published') {
      throw new ForbiddenException('无权查看该资源');
    }

    // 科目查看权限校验
    const canView = await this.checkSubjectPermission(
      currentTeacherId,
      resource.program as ProgramCode,
      resource.subject,
      resource.subSubject ?? undefined,
      'view',
    );
    if (!canView) {
      await this.logAudit({
        action: 'permission_denied',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        errorMessage: '无科目查看权限',
        ipAddress: ip,
      });
      throw new ForbiddenException('无该科目查看权限');
    }

    // 获取教师姓名
    const teacherIds = new Set<string>();
    if (resource.uploaderId) teacherIds.add(resource.uploaderId);
    if (resource.reviewerId) teacherIds.add(resource.reviewerId);

    const teacherMap = new Map<string, string>();
    if (teacherIds.size > 0) {
      const teacherRows = await this.db
        .select({ id: teachers.id, name: teachers.name })
        .from(teachers)
        .where(inArray(teachers.id, [...teacherIds]));
      for (const t of teacherRows) {
        teacherMap.set(t.id, t.name);
      }
    }

    return {
      id: resource.id,
      title: resource.title,
      titleEn: resource.titleEn ?? undefined,
      program: resource.program as ProgramCode,
      subject: resource.subject,
      subSubject: resource.subSubject ?? undefined,
      folderType: resource.folderType as Resource['folderType'],
      semester: resource.semester ?? undefined,
      weekNumber: resource.weekNumber ?? undefined,
      theme: resource.theme ?? undefined,
      description: resource.description ?? undefined,
      fileName: resource.fileName ?? undefined,
      fileSize: resource.fileSize ?? undefined,
      fileType: resource.fileType ?? undefined,
      version: resource.version,
      status: resource.status as Resource['status'],
      uploaderId: resource.uploaderId,
      uploaderName: teacherMap.get(resource.uploaderId) ?? '未知教师',
      reviewerId: resource.reviewerId ?? undefined,
      reviewerName: resource.reviewerId
        ? teacherMap.get(resource.reviewerId)
        : undefined,
      reviewComment: resource.reviewComment ?? undefined,
      reviewedAt: resource.reviewedAt
        ? new Date(resource.reviewedAt).toISOString()
        : undefined,
      createdAt: new Date(resource.createdAt).toISOString(),
      updatedAt: new Date(resource.updatedAt).toISOString(),
    };
  }

  // ========== 创建资源 ==========

  async createResource(
    dto: CreateResourceRequest,
    currentTeacherId: string,
    ip?: string,
  ): Promise<Resource> {
    // 科目上传权限校验
    const canUpload = await this.checkSubjectPermission(
      currentTeacherId,
      dto.program,
      dto.subject,
      dto.subSubject,
      'upload',
    );
    if (!canUpload) {
      await this.logAudit({
        action: 'permission_denied',
        teacherId: currentTeacherId,
        program: dto.program,
        subject: dto.subject,
        success: false,
        errorMessage: '无科目上传权限',
        ipAddress: ip,
        detail: `尝试上传资源：${dto.title}`,
      });
      throw new ForbiddenException('无该科目上传权限');
    }

    const teacherInfo = await this.getTeacherById(currentTeacherId);
    if (!teacherInfo) {
      throw new ForbiddenException('教师账号不存在');
    }

    try {
      const insertValues = {
        title: dto.title,
        titleEn: dto.titleEn,
        program: dto.program,
        subject: dto.subject,
        subSubject: dto.subSubject,
        folderType: dto.folderType,
        semester: dto.semester,
        weekNumber: dto.weekNumber,
        theme: dto.theme,
        description: dto.description,
        fileBucketId: dto.fileBucketId,
        filePath: dto.filePath,
        fileName: dto.fileName,
        fileSize: dto.fileSize,
        fileType: dto.fileType,
        status: 'draft' as const,
        version: 1,
        uploaderId: currentTeacherId,
      };

      const inserted = await this.db
        .insert(resources)
        .values(insertValues)
        .returning();

      const newResource = inserted[0];

      await this.logAudit({
        action: 'resource_upload',
        teacherId: currentTeacherId,
        teacherName: teacherInfo.name,
        resourceId: newResource.id,
        resourceTitle: newResource.title,
        program: newResource.program,
        subject: newResource.subject,
        success: true,
        ipAddress: ip,
      });

      return {
        id: newResource.id,
        title: newResource.title,
        titleEn: newResource.titleEn ?? undefined,
        program: newResource.program as ProgramCode,
        subject: newResource.subject,
        subSubject: newResource.subSubject ?? undefined,
        folderType: newResource.folderType as Resource['folderType'],
        semester: newResource.semester ?? undefined,
        weekNumber: newResource.weekNumber ?? undefined,
        theme: newResource.theme ?? undefined,
        description: newResource.description ?? undefined,
        fileName: newResource.fileName ?? undefined,
        fileSize: newResource.fileSize ?? undefined,
        fileType: newResource.fileType ?? undefined,
        version: newResource.version,
        status: newResource.status as Resource['status'],
        uploaderId: newResource.uploaderId,
        uploaderName: teacherInfo.name,
        createdAt: new Date(newResource.createdAt).toISOString(),
        updatedAt: new Date(newResource.updatedAt).toISOString(),
      };
    } catch (error) {
      this.logger.error(`createResource failed: ${(error as Error).message}`);
      throw error;
    }
  }

  // ========== 更新资源 ==========

  async updateResource(
    id: string,
    dto: UpdateResourceRequest,
    currentTeacherId: string,
    ip?: string,
  ): Promise<Resource> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const resource = rows[0];
    const isAdmin = await this.isAdminTeacher(currentTeacherId);
    const isUploader = resource.uploaderId === currentTeacherId;

    if (!isAdmin && !isUploader) {
      throw new ForbiddenException('只有上传者本人或管理员可以编辑资源');
    }

    // published 状态的资源不能直接编辑
    if (resource.status === 'published') {
      throw new BadRequestException(
        '已发布的资源不能直接编辑，请先退回草稿或创建新版本',
      );
    }

    const patch: Partial<typeof resources.$inferInsert> = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.titleEn !== undefined) patch.titleEn = dto.titleEn;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.semester !== undefined) patch.semester = dto.semester;
    if (dto.weekNumber !== undefined) patch.weekNumber = dto.weekNumber;
    if (dto.theme !== undefined) patch.theme = dto.theme;
    if (dto.fileBucketId !== undefined) patch.fileBucketId = dto.fileBucketId;
    if (dto.filePath !== undefined) patch.filePath = dto.filePath;
    if (dto.fileName !== undefined) patch.fileName = dto.fileName;
    if (dto.fileSize !== undefined) patch.fileSize = dto.fileSize;
    if (dto.fileType !== undefined) patch.fileType = dto.fileType;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }

    try {
      const updated = await this.db
        .update(resources)
        .set(patch)
        .where(eq(resources.id, id))
        .returning();

      const updatedResource = updated[0];
      const teacherInfo = await this.getTeacherById(currentTeacherId);

      await this.logAudit({
        action: 'resource_edit',
        teacherId: currentTeacherId,
        teacherName: teacherInfo?.name,
        resourceId: updatedResource.id,
        resourceTitle: updatedResource.title,
        program: updatedResource.program,
        subject: updatedResource.subject,
        success: true,
        ipAddress: ip,
        detail: `更新字段：${Object.keys(patch).join(', ')}`,
      });

      return {
        id: updatedResource.id,
        title: updatedResource.title,
        titleEn: updatedResource.titleEn ?? undefined,
        program: updatedResource.program as ProgramCode,
        subject: updatedResource.subject,
        subSubject: updatedResource.subSubject ?? undefined,
        folderType: updatedResource.folderType as Resource['folderType'],
        semester: updatedResource.semester ?? undefined,
        weekNumber: updatedResource.weekNumber ?? undefined,
        theme: updatedResource.theme ?? undefined,
        description: updatedResource.description ?? undefined,
        fileName: updatedResource.fileName ?? undefined,
        fileSize: updatedResource.fileSize ?? undefined,
        fileType: updatedResource.fileType ?? undefined,
        version: updatedResource.version,
        status: updatedResource.status as Resource['status'],
        uploaderId: updatedResource.uploaderId,
        uploaderName:
          (await this.getTeacherById(updatedResource.uploaderId))?.name ??
          '未知教师',
        createdAt: new Date(updatedResource.createdAt).toISOString(),
        updatedAt: new Date(updatedResource.updatedAt).toISOString(),
      };
    } catch (error) {
      this.logger.error(`updateResource failed: ${(error as Error).message}`);
      throw error;
    }
  }

  // ========== 删除资源 ==========

  async deleteResource(
    id: string,
    currentTeacherId: string,
    ip?: string,
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const resource = rows[0];
    const isAdmin = await this.isAdminTeacher(currentTeacherId);
    const isUploader = resource.uploaderId === currentTeacherId;

    if (!isAdmin && !isUploader) {
      throw new ForbiddenException('只有上传者本人或管理员可以删除资源');
    }

    try {
      await this.db.delete(resources).where(eq(resources.id, id));

      const teacherInfo = await this.getTeacherById(currentTeacherId);

      await this.logAudit({
        action: 'resource_edit',
        teacherId: currentTeacherId,
        teacherName: teacherInfo?.name,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: true,
        ipAddress: ip,
        detail: '删除资源',
      });
    } catch (error) {
      this.logger.error(`deleteResource failed: ${(error as Error).message}`);
      throw error;
    }
  }

  // ========== 提交审核 ==========

  async submitReview(
    id: string,
    currentTeacherId: string,
    ip?: string,
  ): Promise<Resource> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const resource = rows[0];

    if (resource.uploaderId !== currentTeacherId) {
      throw new ForbiddenException('只有上传者本人可以提交审核');
    }

    if (resource.status !== 'draft' && resource.status !== 'rejected') {
      throw new BadRequestException(
        '只有草稿或已退回状态的资源可以提交审核',
      );
    }

    try {
      const updated = await this.db
        .update(resources)
        .set({ status: 'pending_review' })
        .where(eq(resources.id, id))
        .returning();

      const updatedResource = updated[0];
      const teacherInfo = await this.getTeacherById(currentTeacherId);

      await this.logAudit({
        action: 'resource_submit_review',
        teacherId: currentTeacherId,
        teacherName: teacherInfo?.name,
        resourceId: updatedResource.id,
        resourceTitle: updatedResource.title,
        program: updatedResource.program,
        subject: updatedResource.subject,
        success: true,
        ipAddress: ip,
      });

      return {
        id: updatedResource.id,
        title: updatedResource.title,
        titleEn: updatedResource.titleEn ?? undefined,
        program: updatedResource.program as ProgramCode,
        subject: updatedResource.subject,
        subSubject: updatedResource.subSubject ?? undefined,
        folderType: updatedResource.folderType as Resource['folderType'],
        semester: updatedResource.semester ?? undefined,
        weekNumber: updatedResource.weekNumber ?? undefined,
        theme: updatedResource.theme ?? undefined,
        description: updatedResource.description ?? undefined,
        fileName: updatedResource.fileName ?? undefined,
        fileSize: updatedResource.fileSize ?? undefined,
        fileType: updatedResource.fileType ?? undefined,
        version: updatedResource.version,
        status: updatedResource.status as Resource['status'],
        uploaderId: updatedResource.uploaderId,
        uploaderName: teacherInfo?.name ?? '未知教师',
        createdAt: new Date(updatedResource.createdAt).toISOString(),
        updatedAt: new Date(updatedResource.updatedAt).toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `submitReview failed: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // ========== 我的资源 ==========

  async getMyResources(
    currentTeacherId: string,
    params: { status?: string; page?: number; pageSize?: number },
  ): Promise<ResourceListResponse> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const conditions = [eq(resources.uploaderId, currentTeacherId)];
    if (params.status) {
      conditions.push(eq(resources.status, params.status));
    }
    const whereClause = and(...conditions);

    try {
      const countResult = await this.db
        .select({ value: count() })
        .from(resources)
        .where(whereClause);
      const total = countResult[0]?.value ?? 0;

      const items = await this.db
        .select()
        .from(resources)
        .where(whereClause)
        .orderBy(desc(resources.createdAt))
        .limit(pageSize)
        .offset(offset);

      const reviewerIds = new Set<string>();
      for (const item of items) {
        if (item.reviewerId) reviewerIds.add(item.reviewerId);
      }

      const teacherMap = new Map<string, string>();
      if (reviewerIds.size > 0) {
        const teacherRows = await this.db
          .select({ id: teachers.id, name: teachers.name })
          .from(teachers)
          .where(inArray(teachers.id, [...reviewerIds]));
        for (const t of teacherRows) {
          teacherMap.set(t.id, t.name);
        }
      }

      const teacherInfo = await this.getTeacherById(currentTeacherId);
      const uploaderName = teacherInfo?.name ?? '未知教师';

      const resultItems: Resource[] = items.map((item) => ({
        id: item.id,
        title: item.title,
        titleEn: item.titleEn ?? undefined,
        program: item.program as ProgramCode,
        subject: item.subject,
        subSubject: item.subSubject ?? undefined,
        folderType: item.folderType as Resource['folderType'],
        semester: item.semester ?? undefined,
        weekNumber: item.weekNumber ?? undefined,
        theme: item.theme ?? undefined,
        description: item.description ?? undefined,
        fileName: item.fileName ?? undefined,
        fileSize: item.fileSize ?? undefined,
        fileType: item.fileType ?? undefined,
        version: item.version,
        status: item.status as Resource['status'],
        uploaderId: item.uploaderId,
        uploaderName,
        reviewerId: item.reviewerId ?? undefined,
        reviewerName: item.reviewerId
          ? teacherMap.get(item.reviewerId)
          : undefined,
        reviewComment: item.reviewComment ?? undefined,
        reviewedAt: item.reviewedAt
          ? new Date(item.reviewedAt).toISOString()
          : undefined,
        createdAt: new Date(item.createdAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
      }));

      return {
        items: resultItems,
        total,
        page,
        pageSize,
      };
    } catch (error) {
      this.logger.error(`getMyResources failed: ${(error as Error).message}`);
      throw error;
    }
  }

  // ========== 下载资源 ==========

  async getDownloadUrl(
    id: string,
    currentTeacherId: string,
    ip?: string,
  ): Promise<{ downloadUrl: string; fileName: string }> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const resource = rows[0];
    const isAdmin = await this.isAdminTeacher(currentTeacherId);
    const isUploader = resource.uploaderId === currentTeacherId;

    // 权限校验：非管理员非上传者只能下载 published
    if (!isAdmin && !isUploader && resource.status !== 'published') {
      await this.logAudit({
        action: 'resource_download_denied',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        errorMessage: '资源未发布，无权下载',
        ipAddress: ip,
      });
      throw new ForbiddenException('无权下载该资源');
    }

    // 科目查看权限
    const canView = await this.checkSubjectPermission(
      currentTeacherId,
      resource.program as ProgramCode,
      resource.subject,
      resource.subSubject ?? undefined,
      'view',
    );
    if (!canView) {
      await this.logAudit({
        action: 'resource_download_denied',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        errorMessage: '无该科目查看权限',
        ipAddress: ip,
      });
      throw new ForbiddenException('无该科目查看权限');
    }

    // 检查文件信息
    if (!resource.fileBucketId || !resource.filePath) {
      await this.logAudit({
        action: 'resource_download_denied',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        errorMessage: '资源文件不存在',
        ipAddress: ip,
      });
      throw new NotFoundException('资源文件不存在');
    }

    const teacherInfo = await this.getTeacherById(currentTeacherId);

    await this.logAudit({
      action: 'resource_download',
      teacherId: currentTeacherId,
      teacherName: teacherInfo?.name,
      resourceId: resource.id,
      resourceTitle: resource.title,
      program: resource.program,
      subject: resource.subject,
      success: true,
      ipAddress: ip,
    });

    // TODO: 接入真实 dataloom FileService 获取临时下载链接
    // 目前返回占位 URL
    const downloadUrl = `/api/__platform__/storage/download?bucket=${resource.fileBucketId}&path=${encodeURIComponent(resource.filePath)}`;

    return {
      downloadUrl,
      fileName: resource.fileName ?? 'download',
    };
  }

  async getStorybookCoverStream(
    resourceId: string,
    index: number,
    currentTeacherId: string,
    ip?: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; fileName: string }> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(eq(resources.id, resourceId))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const resource = rows[0];
    const isAdmin = await this.isAdminTeacher(currentTeacherId);
    const isUploader = resource.uploaderId === currentTeacherId;

    if (!isAdmin && !isUploader && resource.status !== 'published') {
      throw new ForbiddenException('无权访问该资源');
    }

    const canView = await this.checkSubjectPermission(
      currentTeacherId,
      resource.program as ProgramCode,
      resource.subject,
      resource.subSubject ?? undefined,
      'view',
    );
    if (!canView) {
      throw new ForbiddenException('无该科目查看权限');
    }

    let weekData: { storybooks?: Array<{ filePath?: string; title?: string }> };
    try {
      weekData = resource.description ? JSON.parse(resource.description) : {};
    } catch {
      throw new BadRequestException('资源描述解析失败');
    }

    const storybooks = weekData.storybooks ?? [];
    if (index < 0 || index >= storybooks.length) {
      throw new NotFoundException('封面不存在');
    }

    const storybook = storybooks[index];
    const filePath = storybook?.filePath;
    if (!filePath) {
      throw new NotFoundException('封面文件路径不存在');
    }

    const fileName = filePath.split('/').pop() || `cover-${index}.jpg`;

    const possiblePaths = [
      join(__dirname, '../../../assets/prek-english-covers/', fileName),
      join(process.cwd(), 'server/assets/prek-english-covers/', fileName),
    ];

    let localPath: string | null = null;
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        localPath = p;
        break;
      }
    }

    if (!localPath) {
      throw new NotFoundException('封面文件不存在');
    }

    const safeFileName = storybook.title ? `${storybook.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg` : `cover-${index}.jpg`;
    const stream = createReadStream(localPath);

    await this.logAudit({
      action: 'storybook_cover_view',
      teacherId: currentTeacherId,
      resourceId: resource.id,
      resourceTitle: resource.title,
      program: resource.program,
      subject: resource.subject,
      detail: `cover index: ${index}, file: ${filePath}`,
      success: true,
      ipAddress: ip,
    });

    return {
      stream,
      contentType: 'image/jpeg',
      fileName: safeFileName,
    };
  }
}
