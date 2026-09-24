import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createReadStream, existsSync } from 'fs';
import { join } from 'path';
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
  isNotNull,
  gte,
  lte,
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
import {
  signDownloadToken,
  downloadTokenConfigurationError,
  downloadTokenTtlSeconds,
  DOWNLOAD_TOKEN_SECRET_ENV,
} from '@server/common/crypto/download-token';
import {
  validateUpload,
  // Every stored/consumed path goes through the normaliser, which itself applies
  // the strict bucket-relative predicate — so this module never calls
  // `isPathTraversalSafe` directly (two spellings of the same rule is how they drift).
  toBucketRelativePath,
  sanitizeFileName,
  FALLBACK_FILENAME,
} from '@server/common/files/file-validation';
import {
  normalizeSubSubject,
  normalizeTheme,
  themeDbValue,
} from '@shared/curriculum';
import {
  describeCoverAssetsResolution,
  describeMissingCoverAsset,
  resolveCoverAssets,
  type CoverAssetsFound,
} from '@server/modules/health/cover-assets';

const ADMIN_ROLES: RoleCode[] = ['principal', 'curriculum_director'];

/**
 * A request's curriculum address, resolved to canonical tokens.
 *
 * `subSubject` and `theme` are the two values the client used to send in its own
 * spelling (`practical-life`, `Myself`) while the database stored
 * `practical_life` / `主题1：我自己`. Comparing those directly matched ZERO rows
 * and returned a successful, empty page — verified: the live database holds 80
 * rows at `prek/montessori/practical_life`, 43 at `prek/montessori/english_language`
 * and 44 at `k/english` with a non-null theme, and none of them was reachable.
 *
 * `theme` is carried in TWO forms because they answer different questions:
 *   * `themeToken` — the canonical slug, for comparing and for echoing back;
 *   * `themeStoredValue` — the exact string to put in `WHERE theme = …`, which is
 *     what makes the fix backward compatible: no row is rewritten, the query is
 *     simply translated into the spelling the rows already use.
 */
interface ResolvedScope {
  program?: ProgramCode;
  subject?: string;
  subSubject?: string;
  themeToken?: string;
  themeStoredValue?: string;
}

/**
 * Normalise the curriculum part of an incoming request, ONCE, at the boundary.
 *
 * Throws BadRequestException on a value it does not recognise. That is the whole
 * point: the previous code accepted anything, matched nothing, and returned
 * `{items: [], total: 0}` with HTTP 200, so a teacher saw "暂无资源" for a folder
 * that holds 80 resources and the API said nothing was wrong. An unknown value is
 * a caller error and must be reported as one.
 *
 * An ABSENT value stays absent (a filter that was not requested is not a filter).
 * An EMPTY STRING is treated as absent, because the client's Select controls emit
 * `''` for "all" (SubjectPage's semester/week selects do exactly this).
 */
function resolveScope(params: {
  program?: string;
  subject?: string;
  subSubject?: string;
  theme?: string;
}): ResolvedScope {
  const raw = (v: string | undefined): string | undefined => {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s === '' ? undefined : s;
  };

  const program = raw(params.program) as ProgramCode | undefined;
  const subject = raw(params.subject);
  const subSubject = raw(params.subSubject);
  const theme = raw(params.theme);

  const out: ResolvedScope = { program, subject };

  if (subSubject === undefined) return resolveTheme(out, theme);

  // A sub-subject without its subject cannot be resolved: 'math' exists under
  // prek/montessori AND under k/english, so guessing would pick one arbitrarily.
  if (program === undefined || subject === undefined) {
    throw new BadRequestException(
      `无法解析子科目 "${subSubject}"：缺少 program 或 subject 上下文。`,
    );
  }

  const canonical = normalizeSubSubject(program, subject, subSubject);
  if (canonical === null) {
    throw new BadRequestException(
      `未知的子科目 "${subSubject}"（program=${program}, subject=${subject}）。` +
        '可用的规范标识见 GET /api/curriculum/structure。',
    );
  }
  out.subSubject = canonical;
  return resolveTheme(out, theme);
}

/** Second half of resolveScope: translate the theme into its stored spelling. */
function resolveTheme(scope: ResolvedScope, theme: string | undefined): ResolvedScope {
  if (theme === undefined) return scope;
  if (scope.program === undefined || scope.subject === undefined) {
    throw new BadRequestException(
      `无法解析主题 "${theme}"：缺少 program 或 subject 上下文。`,
    );
  }
  const token = normalizeTheme(scope.program, scope.subject, theme);
  const stored = themeDbValue(scope.program, scope.subject, theme);
  if (token === null || stored === null) {
    throw new BadRequestException(
      `未知的主题 "${theme}"（program=${scope.program}, subject=${scope.subject}）。` +
        '可用的规范标识见 GET /api/curriculum/structure。',
    );
  }
  return { ...scope, themeToken: token, themeStoredValue: stored };
}

/**
 * Retention window for the recycle bin.
 *
 * The value is deliberately NOT a constant: it is policy, it differs per school,
 * and it must be changeable without a code change. It is validated loudly rather
 * than silently defaulted, because an operator who sets it to `0` or `abc` and
 * gets 30 days anyway would believe the purge policy they intended was in force.
 */
export const RESOURCE_RETENTION_DAYS_ENV = 'RESOURCE_RETENTION_DAYS';
export const DEFAULT_RESOURCE_RETENTION_DAYS = 30;
/** Upper bound: a decade. Beyond this the "recycle bin" is just storage. */
export const MAX_RESOURCE_RETENTION_DAYS = 3650;

/**
 * How many bytes of a file's head `registerFile` will accept.
 *
 * Only the leading bytes are ever needed to identify a format, so this bounds the
 * work and the payload: an oversized value is truncated by `decodeHeadBytes()`
 * rather than trusted wholesale.
 */
export const MAX_HEAD_BYTES = 4096;

function resourceRetentionDays(): number {
  const raw = process.env[RESOURCE_RETENTION_DAYS_ENV];
  if (raw === undefined || raw === '') return DEFAULT_RESOURCE_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${RESOURCE_RETENTION_DAYS_ENV} must be a positive number of days; got "${raw}"`,
    );
  }
  return Math.min(Math.floor(parsed), MAX_RESOURCE_RETENTION_DAYS);
}

/**
 * The fields the download path needs — deliberately not the whole row.
 * Returning the full row would hand every private column to callers that only
 * need to build a URL.
 */
export interface DownloadableResource {
  id: string;
  title: string;
  program: string;
  subject: string;
  subSubject?: string;
  uploaderId: string;
  fileName: string;
  fileBucketId: string;
  filePath: string;
}

/** What a successful `registerFile` persisted. */
export interface RegisteredFile {
  resourceId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  detectedKind: string;
  fileBucketId: string;
  filePath: string;
  /**
   * The database's own verdict on whether the row now points at a real file
   * (`resources.has_stored_file`, migration 0008), read back from the row the
   * UPDATE just wrote rather than inferred from the request.
   *
   * Reporting it here matters for the same reason it matters on the list
   * responses: the upload UI has just told the teacher "uploaded", and it must be
   * able to say whether that produced a downloadable resource. It is read from
   * `.returning(...)`, so it cannot disagree with what was stored.
   */
  hasFile: boolean;
}


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

  /**
   * Recycle-bin administration: business admins (园长/教学主任) plus super_admin.
   *
   * `isAdminTeacher()` intentionally stays business-only, so the EXISTING
   * delete/update checks are unchanged. super_admin is accepted here because
   * listing and restoring from the recycle bin are recovery operations: refusing
   * the platform's highest-privilege account the ability to undo a mistaken
   * deletion would be a safety regression, not a security gain.
   */
  private async isRecycleBinAdmin(teacherId: string): Promise<boolean> {
    const teacher = await this.getTeacherById(teacherId);
    if (!teacher) return false;
    return (
      ADMIN_ROLES.some((r: string) => teacher.roles.includes(r)) ||
      teacher.roles.includes('super_admin')
    );
  }

  /**
   * The ACTIVE-row predicate.
   *
   * Soft delete is enforced HERE, in every query, and deliberately not in RLS:
   * the recycle bin and restore run under the same database role as ordinary
   * reads, so a row-level policy that hid `deleted_at IS NOT NULL` would also
   * hide the recycle bin and silently turn restore into a zero-row UPDATE.
   * See the header of 0007_resource_soft_delete.sql.
   */
  private activeOnly(): SQLWrapper {
    return isNull(resources.deletedAt);
  }

  /**
   * Derive a safe LOCAL file name from a STORED cover path.
   *
   * This is the one place where a stored path is turned into a local filesystem
   * path (`join(<assets dir>, fileName)`), so it is exactly where traversal must
   * be stopped: a stored value ending in `..` would otherwise make `join()` climb
   * out of the covers directory.
   *
   * THREE steps, because each answers a different question:
   *   1. `toBucketRelativePath` normalises the platform's real key shape
   *      (`/curriculum-resources/…`, leading slash — see seed-curriculum.sql) into
   *      the bucket-relative form and refuses anything that cannot be made safe
   *      (traversal, UNC, drive letters, `~`, doubled separators);
   *   2. the BASENAME is taken, so no separator can survive into the join;
   *   3. `sanitizeFileName` reduces what remains to one safe component.
   * Skipping (1) would reject every real Pre-K English cover; skipping (2) or (3)
   * would leave the filesystem join trusting a client-influenced value.
   */
  private coverFileNameFrom(storedPath: string, index: number): string {
    const bucketRelative = toBucketRelativePath(storedPath);
    if (bucketRelative === null) {
      throw new BadRequestException('封面文件路径非法');
    }
    const lastSegment = bucketRelative.split(/[\\/]+/).pop() ?? '';
    const sanitized = sanitizeFileName(lastSegment);
    return sanitized === FALLBACK_FILENAME ? `cover-${index}.jpg` : sanitized;
  }

  /**
   * Turn a validated cover FILE NAME into an existing file on this machine, or fail
   * with a diagnostic that says which of the two problems it actually is.
   *
   * REPLACES the two hand-written `possiblePaths` guesses that used to live inline in
   * `getStorybookCoverStream()` and `getPublicStorybookCoverStream()`:
   *
   *     join(__dirname, '../../../assets/prek-english-covers/', fileName)  // never right
   *     join(process.cwd(), 'server/assets/prek-english-covers/', fileName) // cwd-dependent
   *
   * Measured consequences of those two lines: the first resolved to `dist/assets/…`
   * (which does not exist — `nest-cli.json` publishes to `dist/server/assets/…`), so
   * it could never match in any build; and the endpoint therefore worked ONLY when
   * the process happened to be started with `cwd=dist`. Started any other way every
   * cover became a bare 404 — indistinguishable from "this cover was never shipped",
   * with nothing in the log. The resolution order and its logging now live in
   * `@server/modules/health/cover-assets`, which is also what the readiness probe
   * reports, so the probe and this path cannot disagree.
   *
   * TWO failures, TWO different answers, because they are different problems:
   *
   *   * the asset DIRECTORY is missing       -> 503. The deployment is incomplete;
   *     no cover can be served and retrying will not help. Reported as "not my
   *     request's fault" rather than as a 404 that blames the resource.
   *   * the directory exists, FILE is absent -> 404 with the file NAME in the body,
   *     plus an ERROR in the log naming the resolved directory. A 404 is correct here
   *     (that cover is genuinely not in this deployment), but it is now diagnosable.
   *
   * The absolute directory path is deliberately NOT put in the response body: the
   * project's rule for anything that reaches a client is STATE, never filesystem
   * layout (audit finding G-11). It goes to the log, where an operator can use it.
   */
  private resolveLocalCoverFile(fileName: string): string {
    // Anchored on THIS module's own directory (not on `process.cwd()`), so the
    // answer does not change with the working directory the server was started from.
    const resolution = resolveCoverAssets({ moduleDir: __dirname, appRoot: process.cwd() });

    if (!resolution.ok) {
      this.logger.error(
        `storybook cover unavailable: ${describeCoverAssetsResolution(resolution)} ` +
          `(requested file '${fileName}')`,
      );
      throw new ServiceUnavailableException(
        '绘本封面文件目录不可用：服务端未找到封面资源目录，无法提供封面。' +
          '这是部署产物问题（缺少 assets/prek-english-covers），请检查构建与发布步骤；' +
          '服务端日志已记录全部候选路径。（Storage: cover assets directory missing）',
      );
    }

    const localPath = join(resolution.dir, fileName);
    if (!existsSync(localPath)) {
      this.logger.error(describeMissingCoverAsset(fileName, resolution as CoverAssetsFound));
      throw new NotFoundException(
        `封面文件不存在：${fileName}（该文件不在本实例的封面资源目录中）；` +
          '服务端日志已记录已解析的目录与来源。（Cover asset not present in this deployment）',
      );
    }

    return localPath;
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

    // Boundary: resolve program/subject/sub-subject/theme to canonical tokens
    // BEFORE any comparison. Everything below this line may safely assume
    // `scope.subSubject` is a stored value and `scope.themeStoredValue` is the
    // exact string `resources.theme` holds. An unknown value throws 400 here.
    const scope = resolveScope(params);

    const isAdmin = await this.isAdminTeacher(currentTeacherId);

    // Soft delete is excluded for EVERY caller, administrators included: a deleted
    // resource belongs to the recycle bin, not to the normal listing. Without this
    // line a deleted resource would still appear in search, in the subject page
    // and in the dashboard counts.
    const conditions = [this.activeOnly()];

    // 科目权限过滤：非管理员只能看有权限的科目
    if (!isAdmin) {
      const permConditions = await this.buildPermissionCondition(
        currentTeacherId,
        scope.program,
        scope.subject,
        scope.subSubject,
      );
      if (permConditions === null) {
        // 明确指定了科目但无权限：返回 403
        if (scope.program && scope.subject) {
          await this.logAudit({
            action: 'permission_denied',
            teacherId: currentTeacherId,
            program: scope.program,
            subject: scope.subject,
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
      if (scope.program) {
        conditions.push(eq(resources.program, scope.program));
        if (scope.subject) {
          conditions.push(eq(resources.subject, scope.subject));
        }
        if (scope.subSubject) {
          conditions.push(eq(resources.subSubject, scope.subSubject));
        }
      }
    } else if (scope.program) {
      conditions.push(eq(resources.program, scope.program));
      if (scope.subject) {
        conditions.push(eq(resources.subject, scope.subject));
      }
      if (scope.subSubject) {
        conditions.push(eq(resources.subSubject, scope.subSubject));
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
    if (scope.themeStoredValue) {
      // Compare against the STORED spelling, not the requested one. This is what
      // makes `theme=myself` find the rows that hold `主题1：我自己` without any of
      // those rows being rewritten — see resolveScope().
      conditions.push(eq(resources.theme, scope.themeStoredValue));
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
        hasFile: item.hasStoredFile ?? false,
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

    // Same boundary normalisation as listResources(): a guest request is a request.
    const scope = resolveScope(params);

    // Public/guest listing: published AND not soft-deleted.
    const conditions = [this.activeOnly()];

    if (scope.program) {
      conditions.push(eq(resources.program, scope.program));
      if (scope.subject) {
        conditions.push(eq(resources.subject, scope.subject));
      }
      if (scope.subSubject) {
        conditions.push(eq(resources.subSubject, scope.subSubject));
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
    if (scope.themeStoredValue) {
      conditions.push(eq(resources.theme, scope.themeStoredValue));
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
      hasFile: item.hasStoredFile ?? false,
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
      .where(
        and(
          eq(resources.id, id),
          eq(resources.status, 'published'),
          this.activeOnly(),
        ),
      )
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
      hasFile: resource.hasStoredFile ?? false,
      version: resource.version,
      status: resource.status as Resource['status'],
      uploaderId: resource.uploaderId,
      uploaderName,
      createdAt: new Date(resource.createdAt).toISOString(),
      updatedAt: new Date(resource.updatedAt).toISOString(),
    };
  }

  /**
   * Guest / unauthenticated download — CLOSED, on purpose.
   *
   * This was the SECOND copy of the old download-URL builder (the other being
   * `getDownloadUrl()` below). Both produced
   *
   *     /api/__platform__/storage/download?bucket=<bucket>&path=<path>
   *
   * which hands the caller the object's location inside the private bucket and
   * never expires. That is precisely the vulnerability phase 6 removes, so this
   * method can no longer mint it.
   *
   * It also CANNOT mint the replacement: a download token is bound to a
   * `teacherId`, and this entry point has no caller identity by construction.
   * The honest outcome is to refuse — loudly and with an audit row — rather than
   * to fall back to an unauthenticated URL, which is what "no caller" used to
   * mean. Guest access must authenticate and use `GET /api/files/download`.
   *
   * NOTE (scope): this method currently has NO caller in the codebase — no route
   * ever exposed it. It is kept (rather than deleted) so the public read-only API
   * surface stays visible, and so a future guest mode has to confront this
   * decision instead of silently re-introducing a permanent link.
   */
  async getPublicDownloadUrl(
    id: string,
    ip?: string,
  ): Promise<{ downloadUrl: string; fileName: string }> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.id, id),
          eq(resources.status, 'published'),
          this.activeOnly(),
        ),
      )
      .limit(1);

    const resource = rows[0];
    if (resource) {
      await this.logAudit({
        action: 'resource_download_denied',
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        ipAddress: ip,
        errorMessage: '未登录的公开下载通道已关闭',
        detail: '公共下载入口不再签发无账号绑定、无有效期的链接',
      });
    }

    throw new ForbiddenException(
      '未登录的公开下载通道已关闭：下载必须通过登录后的签名链接 ' +
        '（GET /api/files/download），该链接与账号绑定且短时有效。',
    );
  }

  async getPublicStorybookCoverStream(
    resourceId: string,
    index: number,
    ip?: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; fileName: string }> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.id, resourceId),
          eq(resources.status, 'published'),
          this.activeOnly(),
        ),
      )
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

    const fileName = this.coverFileNameFrom(filePath, index);
    const localPath = this.resolveLocalCoverFile(fileName);

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
      // A soft-deleted resource is 404 here, even for its uploader and for
      // administrators: it exists only in the recycle bin.
      .where(and(eq(resources.id, id), this.activeOnly()))
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
      hasFile: resource.hasStoredFile ?? false,
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
    // Boundary normalisation, exactly as on the read paths: an UPLOAD is how a row
    // acquires its spelling in the first place, so letting a create accept
    // `practical-life` while every read stores `practical_life` would keep
    // producing the unreachable rows this phase removes. Unknown values throw 400
    // rather than being written.
    const scope = resolveScope(dto);

    // 科目上传权限校验
    const canUpload = await this.checkSubjectPermission(
      currentTeacherId,
      scope.program ?? dto.program,
      scope.subject ?? dto.subject,
      scope.subSubject,
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
        program: scope.program ?? dto.program,
        subject: scope.subject ?? dto.subject,
        subSubject: scope.subSubject,
        folderType: dto.folderType,
        semester: dto.semester,
        weekNumber: dto.weekNumber,
        // The STORED spelling, so a resource created through the UI lands in the
        // same bucket of rows the theme filter will later look in.
        theme: scope.themeStoredValue,
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
        hasFile: newResource.hasStoredFile ?? false,
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
      // Editing a deleted resource is refused: restore it first, so the edit is
      // visible and the audit trail reads in the order things actually happened.
      .where(and(eq(resources.id, id), this.activeOnly()))
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
    if (dto.theme !== undefined) {
      // The program/subject come from the ROW, not the request: `theme` is only
      // interpretable inside a subject's vocabulary, and this endpoint does not
      // accept a program/subject change. Resolving against the row is what keeps
      // an editor's `theme=myself` stored as the `主题1：我自己` its siblings use.
      const themeScope = resolveScope({
        program: resource.program,
        subject: resource.subject,
        theme: dto.theme,
      });
      patch.theme = themeScope.themeStoredValue;
    }
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
        hasFile: updatedResource.hasStoredFile ?? false,
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

  // ========== 删除资源（回收站 / 软删除） ==========

  /**
   * Move a resource to the recycle bin (SOFT delete).
   *
   * HISTORY: this used to run `delete from resources where id = $1`. A hard
   * delete from a UI button is unrecoverable: one mis-click destroyed the row,
   * the audit log recorded that it happened but not what it contained, and the
   * file in object storage was orphaned. The platform's own permission catalog
   * already described the intended behaviour (`resource.delete` = "将资源移入回收站
   * （软删除）"), so the permission checks and the audit entry are unchanged and
   * only the mechanism moved from DELETE to UPDATE.
   *
   * The retention window is stored ON THE ROW (`purge_after`) so that changing the
   * policy later cannot retroactively change the fate of rows already in the bin.
   */
  async deleteResource(
    id: string,
    currentTeacherId: string,
    ip?: string,
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, id), this.activeOnly()))
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

    const retentionDays = resourceRetentionDays();
    const deletedAt = new Date();
    const purgeAfter = new Date(deletedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);

    let affected = 0;
    try {
      const updated = await this.db
        .update(resources)
        .set({ deletedAt, deletedBy: currentTeacherId, purgeAfter })
        // `activeOnly()` in the predicate makes this the atomic guard against a
        // double delete: the second UPDATE matches no row, so a resource can not
        // be pushed to the back of the retention queue by a repeated click.
        .where(and(eq(resources.id, id), this.activeOnly()))
        .returning({ id: resources.id });
      affected = updated.length;
    } catch (error) {
      this.logger.error(`deleteResource failed: ${(error as Error).message}`);
      throw error;
    }

    if (affected === 0) {
      throw new BadRequestException('资源已在回收站中');
    }

    const teacherInfo = await this.getTeacherById(currentTeacherId);
    await this.logAudit({
      action: 'resource_delete',
      teacherId: currentTeacherId,
      teacherName: teacherInfo?.name,
      resourceId: resource.id,
      resourceTitle: resource.title,
      program: resource.program,
      subject: resource.subject,
      success: true,
      ipAddress: ip,
      detail:
        `移入回收站（软删除），保留 ${retentionDays} 天，` +
        `purge_after=${purgeAfter.toISOString()}。可用 POST /api/resources/:id/restore 恢复`,
    });
  }

  /**
   * Restore a resource from the recycle bin.
   *
   * Permission mirrors delete: the uploader or an administrator (business admin
   * or super_admin). The purge window is deliberately NOT re-checked here: if the
   * row still exists, restoring it loses nothing, whereas refusing would destroy
   * the teacher's work because a sweep had not run yet.
   */
  async restoreResource(
    id: string,
    currentTeacherId: string,
    ip?: string,
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, id), isNotNull(resources.deletedAt)))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不在回收站中');
    }

    const resource = rows[0];
    const isAdmin = await this.isRecycleBinAdmin(currentTeacherId);
    const isUploader = resource.uploaderId === currentTeacherId;

    if (!isAdmin && !isUploader) {
      await this.logAudit({
        action: 'permission_denied',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        errorMessage: '无权从回收站恢复该资源',
        ipAddress: ip,
      });
      throw new ForbiddenException('只有上传者本人或管理员可以从回收站恢复资源');
    }

    const updated = await this.db
      .update(resources)
      .set({ deletedAt: null, deletedBy: null, purgeAfter: null })
      .where(and(eq(resources.id, id), isNotNull(resources.deletedAt)))
      .returning({ id: resources.id });

    if (updated.length === 0) {
      throw new NotFoundException('资源不在回收站中');
    }

    const teacherInfo = await this.getTeacherById(currentTeacherId);
    await this.logAudit({
      action: 'resource_restore',
      teacherId: currentTeacherId,
      teacherName: teacherInfo?.name,
      resourceId: resource.id,
      resourceTitle: resource.title,
      program: resource.program,
      subject: resource.subject,
      success: true,
      ipAddress: ip,
      detail:
        `从回收站恢复（原删除时间 ` +
        `${resource.deletedAt ? new Date(resource.deletedAt).toISOString() : '未知'}）`,
    });
  }

  /**
   * The recycle bin.
   *
   * Administrator-only, and NOT subject-scoped: a resource that has been deleted
   * has left the normal curriculum tree, so "which subjects may I see" no longer
   * describes who should be able to restore it. The route additionally requires
   * the `resource.restore` permission.
   */
  async listDeletedResources(
    params: { page?: number; pageSize?: number } = {},
  ): Promise<ResourceListResponse> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const whereClause = isNotNull(resources.deletedAt);

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
        // Newest deletion first: the most recent mistake is the one being looked for.
        .orderBy(desc(resources.deletedAt))
        .limit(pageSize)
        .offset(offset);

      const teacherIds = new Set<string>();
      for (const item of items) {
        if (item.uploaderId) teacherIds.add(item.uploaderId);
        if (item.deletedBy) teacherIds.add(item.deletedBy);
        if (item.reviewerId) teacherIds.add(item.reviewerId);
      }

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
        hasFile: item.hasStoredFile ?? false,
        version: item.version,
        status: item.status as Resource['status'],
        uploaderId: item.uploaderId,
        uploaderName: teacherMap.get(item.uploaderId) ?? '未知教师',
        reviewerId: item.reviewerId ?? undefined,
        reviewerName: item.reviewerId ? teacherMap.get(item.reviewerId) : undefined,
        reviewComment: item.reviewComment ?? undefined,
        reviewedAt: item.reviewedAt ? new Date(item.reviewedAt).toISOString() : undefined,
        createdAt: new Date(item.createdAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
        // Recycle-bin-only fields. Present so the UI can show "who deleted it and
        // when it disappears for good" without a second request.
        deletedAt: item.deletedAt ? new Date(item.deletedAt).toISOString() : undefined,
        deletedByName: item.deletedBy ? teacherMap.get(item.deletedBy) : undefined,
        purgeAfter: item.purgeAfter ? new Date(item.purgeAfter).toISOString() : undefined,
      }));

      return { items: resultItems, total, page, pageSize };
    } catch (error) {
      this.logger.error(`listDeletedResources failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Permanently remove recycle-bin rows whose retention window has elapsed.
   *
   * DELIBERATELY NOT EXPOSED OVER HTTP. It is destructive and irreversible, and a
   * destructive retention sweep must not be triggerable by a request — not even
   * one holding `resource.purge`. This repository has no scheduler, so this method
   * is the seam an operator (or a future cron/scheduled task) calls; it is
   * reachable through the service, not through a route.
   *
   * WHAT IT DOES NOT DO: it does not delete the object from platform storage.
   * There is no usable object-store integration in this environment (see
   * /api/files/download), so a purged row's file becomes an orphaned object in the
   * bucket. That is recorded in the audit detail rather than hidden.
   *
   * `now` is injectable so the retention boundary is testable.
   */
  async purgeExpiredResources(
    now: Date = new Date(),
    options: { dryRun?: boolean; batchSize?: number } = {},
  ): Promise<{ purged: number; resourceIds: string[]; dryRun: boolean }> {
    const batchSize = Math.min(Math.max(options.batchSize ?? 500, 1), 5000);
    const dryRun = options.dryRun === true;

    const rows = await this.db
      .select({
        id: resources.id,
        title: resources.title,
        program: resources.program,
        subject: resources.subject,
        fileBucketId: resources.fileBucketId,
        filePath: resources.filePath,
        purgeAfter: resources.purgeAfter,
      })
      .from(resources)
      .where(
        and(
          isNotNull(resources.deletedAt),
          isNotNull(resources.purgeAfter),
          lte(resources.purgeAfter, now),
        ),
      )
      .orderBy(resources.purgeAfter)
      .limit(batchSize);

    const resourceIds = rows.map((r) => r.id);
    if (dryRun || resourceIds.length === 0) {
      return { purged: 0, resourceIds, dryRun };
    }

    await this.db.delete(resources).where(inArray(resources.id, resourceIds));

    for (const row of rows) {
      await this.logAudit({
        action: 'resource_purge',
        resourceId: row.id,
        resourceTitle: row.title,
        program: row.program,
        subject: row.subject,
        success: true,
        detail:
          `保留期已过（purge_after=${row.purgeAfter ? new Date(row.purgeAfter).toISOString() : '未知'}），` +
          '记录已永久删除' +
          (row.fileBucketId && row.filePath
            ? '；⚠ 对象存储中的文件未删除（本环境无可用存储集成），已变为孤儿对象'
            : ''),
      });
    }

    this.logger.warn(
      `purgeExpiredResources: permanently deleted ${resourceIds.length} resource(s) past retention`,
    );
    return { purged: resourceIds.length, resourceIds, dryRun: false };
  }

  // ========== 文件元数据登记（服务端校验边界） ==========

  /**
   * Register a file against an existing resource, validating BEFORE persisting.
   *
   * WHY A SEPARATE STEP: the client uploads straight to platform storage and only
   * metadata reaches the backend, so this is the one place where the server can
   * refuse a file. Nothing is written unless the name, the extension, the declared
   * MIME type, the size AND the real leading bytes all agree.
   *
   * HONEST LIMITATION (stated, not hidden): the `head` bytes are supplied by the
   * caller. When the caller is the browser that also performed the upload, they are
   * a client assertion — the check then proves only that the client can produce
   * consistent magic bytes, not that the stored object matches them. Making it
   * authoritative requires reading the bytes server-side (upload through the
   * server, or re-read the stored object after upload), which needs the platform
   * object-store integration that is not reachable in this environment. Until
   * then this endpoint must be called by a TRUSTED upload path.
   *
   * Both outcomes are audited: a rejection is a security event worth keeping.
   */
  async registerFile(
    resourceId: string,
    currentTeacherId: string,
    input: {
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      head: string;
      fileBucketId: string;
      filePath: string;
    },
    ip?: string,
  ): Promise<RegisteredFile> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, resourceId), this.activeOnly()))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const resource = rows[0];
    const isAdmin = await this.isAdminTeacher(currentTeacherId);
    const isUploader = resource.uploaderId === currentTeacherId;

    if (!isAdmin && !isUploader) {
      await this.logAudit({
        action: 'permission_denied',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        errorMessage: '无权登记该资源的文件',
        ipAddress: ip,
      });
      throw new ForbiddenException('只有上传者本人或管理员可以登记资源文件');
    }

    // --- validation, BEFORE anything is written -----------------------------
    const head = this.decodeHeadBytes(input.head);
    const validation = validateUpload({
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      head,
    });

    // NOTE the explicit `=== false`: this tsconfig runs with `strict: false`, and
    // a NEGATED truthiness check does not narrow a boolean-literal discriminated
    // union under that setting (verified with tsc against these options).
    if (validation.ok === false) {
      await this.logAudit({
        action: 'file_validation_rejected',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        ipAddress: ip,
        errorMessage: validation.message,
        detail:
          `登记文件被拒绝：code=${validation.code} ` +
          `fileName=${JSON.stringify(input.fileName)} mime=${JSON.stringify(input.mimeType)} ` +
          `size=${String(input.sizeBytes)}`,
      });
      throw new BadRequestException(`文件校验失败：${validation.message}`);
    }

    // The incoming path is a CLIENT value; the stored one must be a
    // bucket-relative key. Normalise first (the platform's own keys are
    // absolute-looking), then require the normalised form to pass the strict
    // predicate — and persist THAT, never the raw input. New rows are therefore
    // canonical, while legacy rows written by the old direct-to-storage flow are
    // handled at read time by the same normaliser (see `authorizeDownload`).
    const bucketRelativePath = toBucketRelativePath(input.filePath);
    if (bucketRelativePath === null) {
      await this.logAudit({
        action: 'file_validation_rejected',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        ipAddress: ip,
        errorMessage: '文件路径非法（疑似路径穿越或绝对路径）',
        detail: `code=PATH_TRAVERSAL filePath=${JSON.stringify(input.filePath)}`,
      });
      throw new BadRequestException('文件存储路径非法');
    }

    if (!this.isSafeBucketId(input.fileBucketId)) {
      await this.logAudit({
        action: 'file_validation_rejected',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        ipAddress: ip,
        errorMessage: '存储 bucket 标识非法',
        detail: `code=INVALID_BUCKET bucket=${JSON.stringify(input.fileBucketId)}`,
      });
      throw new BadRequestException('存储 bucket 标识非法');
    }

    // --- persist the SANITISED name and the NORMALISED mime type ------------
    const updated = await this.db
      .update(resources)
      .set({
        fileName: validation.fileName,
        fileSize: validation.sizeBytes,
        fileType: validation.mimeType,
        fileBucketId: input.fileBucketId,
        // The NORMALISED key, not `input.filePath`.
        filePath: bucketRelativePath,
      })
      .where(and(eq(resources.id, resourceId), this.activeOnly()))
      .returning({
        id: resources.id,
        fileName: resources.fileName,
        hasStoredFile: resources.hasStoredFile,
      });

    if (updated.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    const teacherInfo = await this.getTeacherById(currentTeacherId);
    await this.logAudit({
      action: 'resource_file_register',
      teacherId: currentTeacherId,
      teacherName: teacherInfo?.name,
      resourceId: resource.id,
      resourceTitle: resource.title,
      program: resource.program,
      subject: resource.subject,
      success: true,
      ipAddress: ip,
      detail:
        `文件登记通过：name=${validation.fileName} type=${validation.mimeType} ` +
        `detected=${validation.kind} size=${validation.sizeBytes} bucket=${input.fileBucketId}`,
    });

    return {
      resourceId: resource.id,
      fileName: validation.fileName,
      mimeType: validation.mimeType,
      sizeBytes: validation.sizeBytes,
      detectedKind: validation.kind,
      fileBucketId: input.fileBucketId,
      filePath: bucketRelativePath,
      // From the row the UPDATE returned — not from `validation` or `input`, so a
      // response can never claim a file that the column does not agree with.
      hasFile: updated[0].hasStoredFile ?? false,
    };
  }

  /**
   * Decode the caller-supplied base64 head.
   *
   * Only the first bytes are ever needed, so an oversized or malformed value is
   * truncated / treated as absent rather than trusted: `validateUpload` then
   * refuses with MAGIC_BYTES_MISSING instead of validating a value the caller
   * padded into looking like something else.
   */
  private decodeHeadBytes(raw: string): Buffer {
    if (typeof raw !== 'string' || raw.length === 0) return Buffer.alloc(0);
    const normalized = raw.replace(/[\s]+/g, '');
    if (normalized.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      return Buffer.alloc(0);
    }
    const decoded = Buffer.from(normalized, 'base64');
    return decoded.length > MAX_HEAD_BYTES ? decoded.subarray(0, MAX_HEAD_BYTES) : decoded;
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
      .where(and(eq(resources.id, id), this.activeOnly()))
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
        hasFile: updatedResource.hasStoredFile ?? false,
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

    // "My resources" hides what I deleted too: the recycle bin is the single
    // place that shows deleted rows.
    const conditions = [eq(resources.uploaderId, currentTeacherId), this.activeOnly()];
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
        hasFile: item.hasStoredFile ?? false,
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

  /**
   * Is a bucket id safe to interpolate into a storage request?
   *
   * Bucket ids are opaque platform identifiers, so this is a shape check, not a
   * charset allowlist: it rejects the characters that would let a stored value
   * change the request's structure (separators, control characters) and anything
   * longer than the column that holds it.
   */
  private isSafeBucketId(bucketId: unknown): bucketId is string {
    return (
      typeof bucketId === 'string' &&
      bucketId.length > 0 &&
      bucketId.length <= 100 &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f-\u009f/\\]/.test(bucketId) &&
      !bucketId.includes('..')
    );
  }

  /**
   * Authorise a download and return ONLY what the download path needs.
   *
   * This is the SINGLE implementation of the download authorization rules, shared
   * by both former copies of the URL builder (`getDownloadUrl` and
   * `getPublicDownloadUrl`) and by the `/api/files/download` endpoint that
   * consumes the token. Two copies of a permission check is two chances for them
   * to disagree, and the weaker one wins.
   *
   * Every denial writes an audit row (preserved behaviour); success does NOT —
   * the caller audits what it actually did (minted a link / served bytes), which
   * keeps the two events distinguishable in the log.
   */
  async authorizeDownload(
    id: string,
    currentTeacherId: string,
    ip?: string,
  ): Promise<DownloadableResource> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, id), this.activeOnly()))
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
    //
    // `hasStoredFile` is the database's own derivation of "this row points at a
    // file" (migration 0008: `file_path` AND `file_bucket_id` non-blank). It is
    // read for the DECISION and the two columns are still re-read for the VALUES,
    // because the two must never be able to disagree: the flag decides whether a
    // download is possible, and the columns are what the storage client is handed.
    // Checking the flag alone would trust a derived value for an authorization-ish
    // decision; checking the columns alone is what the code did before, and it left
    // the UI unable to tell an empty row from a real one.
    if (!resource.hasStoredFile || !resource.fileBucketId || !resource.filePath) {
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
        detail:
          '该资源只有元数据，没有关联的存储文件（file_path / file_bucket_id 为空），' +
          '因此不可下载。',
      });
      // The message names the actual situation so a teacher is not left thinking
      // the download is broken. The status stays 404: the FILE does not exist, even
      // though the resource row does. There is deliberately no fallback that serves
      // something else, and no placeholder file is ever invented.
      throw new NotFoundException('资源文件不存在');
    }

    // A stored path is input like any other. It is NORMALISED first (the platform
    // writes absolute-looking keys, and rows predating this phase may hold one),
    // then required to pass the strict bucket-relative predicate; the normalised
    // value is what the storage client receives, so the raw stored string never
    // reaches it. The bucket id is shape-checked at the same time.
    const bucketRelativePath = toBucketRelativePath(resource.filePath);
    if (bucketRelativePath === null || !this.isSafeBucketId(resource.fileBucketId)) {
      await this.logAudit({
        action: 'resource_download_denied',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        errorMessage: '存储路径或 bucket 非法',
        ipAddress: ip,
        detail: '路径穿越、绝对路径或 bucket 形状校验未通过',
      });
      throw new BadRequestException('资源文件路径非法');
    }

    return {
      id: resource.id,
      title: resource.title,
      program: resource.program,
      subject: resource.subject,
      subSubject: resource.subSubject ?? undefined,
      uploaderId: resource.uploaderId,
      // Sanitised on READ as well as on write: rows stored before this phase may
      // hold a hostile name, and the value ends up in a Content-Disposition header.
      fileName: sanitizeFileName(resource.fileName ?? 'download'),
      fileBucketId: resource.fileBucketId,
      // Bucket-RELATIVE, guaranteed by the check above.
      filePath: bucketRelativePath,
    };
  }

  /**
   * Mint the signed, caller-bound, short-lived download URL.
   *
   * The URL never contains the bucket or the object path: it contains an
   * HMAC-signed payload naming the resource and the caller. Verification happens
   * at `GET /api/files/download`, which also requires a session whose teacher id
   * equals the one in the token.
   */
  private buildSignedDownloadUrl(resourceId: string, teacherId: string): string {
    const configError = downloadTokenConfigurationError();
    if (configError) {
      // Fail CLOSED and loudly. There is no fallback URL: the previous
      // implementation's fallback WAS the vulnerability.
      this.logger.error(`download link cannot be signed: ${configError}`);
      throw new ServiceUnavailableException(
        '下载链接签名密钥不可用，暂时无法签发下载链接。' +
          '请检查环境变量 DOWNLOAD_TOKEN_SECRET（openssl rand -base64 32）。',
      );
    }
    const ttlSeconds = downloadTokenTtlSeconds();
    const token = signDownloadToken({ resourceId, teacherId, ttlSeconds });
    return `/api/files/download?token=${encodeURIComponent(token)}`;
  }

  async getDownloadUrl(
    id: string,
    currentTeacherId: string,
    ip?: string,
  ): Promise<{ downloadUrl: string; fileName: string }> {
    const target = await this.authorizeDownload(id, currentTeacherId, ip);

    const teacherInfo = await this.getTeacherById(currentTeacherId);
    const ttlSeconds = downloadTokenTtlSeconds();

    // NOTE ON WHAT IS *NOT* WIRED HERE:
    // this audits that a LINK was issued. The bytes are served (or refused) later
    // by GET /api/files/download, which audits the serving attempt separately and
    // is where the platform object-store integration
    // (@lark-apaas/file-service / dataloom) is actually called. In this
    // environment that call cannot succeed, and it fails with an explicit 503
    // naming the missing integration — never with a silent success.
    await this.logAudit({
      action: 'resource_download',
      teacherId: currentTeacherId,
      teacherName: teacherInfo?.name,
      resourceId: target.id,
      resourceTitle: target.title,
      program: target.program,
      subject: target.subject,
      success: true,
      ipAddress: ip,
      detail: `已签发临时下载链接（有效期 ${ttlSeconds} 秒，绑定当前账号）`,
    });

    return {
      downloadUrl: this.buildSignedDownloadUrl(target.id, currentTeacherId),
      fileName: target.fileName,
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
      .where(and(eq(resources.id, resourceId), this.activeOnly()))
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

    const fileName = this.coverFileNameFrom(filePath, index);
    const localPath = this.resolveLocalCoverFile(fileName);

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
