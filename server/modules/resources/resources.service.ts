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
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/database/database.module';
import {
  OBJECT_STORAGE,
  STORAGE_NOT_CONFIGURED_CODE,
  STORAGE_NOT_CONFIGURED_MESSAGE,
  storageUnavailable,
  type ObjectStorage,
} from '@server/modules/files/object-storage';
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
  ResourceVersion,
  UnderFiledListResponse,
} from '@shared/api.interface';
import {
  resources,
  resourceVersions,
  teachers,
  auditLogs,
  directories,
} from '@server/database/schema';
import { canonicalSubjectOfDirectoryCode } from '@server/modules/directories/directory-vocabulary';
import {
  folderSuffixOf,
  folderTypeForCustomFolder,
  folderTypeFromDirectoryNode,
} from '@server/modules/directories/legacy-folder-mapping';
import {
  signDownloadToken,
  downloadTokenConfigurationError,
  downloadTokenTtlSeconds,
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
import { roleScopeCovers } from '@shared/rbac';
import { AuthorizationService } from '@server/modules/authz/authorization.service';
import { withRbacWriteContext } from '@server/database/rbac-write-context';
import {
  describeCoverAssetsResolution,
  describeMissingCoverAsset,
  resolveCoverAssets,
  type CoverAssetsFound,
} from '@server/modules/health/cover-assets';


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
    // 上传登记前的"本进程到底有没有对象存储"判定。与下载路径用**同一个**
    // 后端实例，所以两边对"是否配置"的回答不可能不一致。
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    // 数据范围判定的**唯一**入口（§3）。本文件不再自己实现
    // "平台管理员 / 角色范围 / subject_permissions" 这条规则。
    private readonly authz: AuthorizationService,
  ) {}

  // ========== 辅助方法 ==========

  private async isAdminTeacher(teacherId: string): Promise<boolean> {
    const teacher = await this.getTeacherById(teacherId);
    if (!teacher) return false;
    // 规则本身在 shared/rbac，读取口在 AuthorizationService —— 本文件不再直接判定。
    return this.authz.isPlatformAdminAccount((teacher.roles ?? []) as RoleCode[]);
  }

  /**
   * Recycle-bin administration: the same platform administrators.
   *
   * This used to be a separate expression that accepted `super_admin` while
   * `isAdminTeacher()` did not, on the reasoning that super_admin is a technical
   * account rather than a "business" one. That split is what made the platform
   * unusable for a super_admin: it could empty the recycle bin but not open a
   * subject page. Recovery operations are just one instance of the general rule
   * in `PLATFORM_ADMIN_ROLES` above — an account that holds every permission at
   * scope ALL must not be refused the ability to act on the whole curriculum.
   *
   * Kept as a named function (rather than folded away) because the call sites read
   * better for it, and because a future product decision to narrow super_admin
   * back to a technical role has exactly one place to land.
   */
  private async isRecycleBinAdmin(teacherId: string): Promise<boolean> {
    return this.isAdminTeacher(teacherId);
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

    // 园长 / 教学主任 / 超级管理员：全部通过
    if (this.authz.isPlatformAdminAccount(roles)) {
      return sql`true`;
    }

    // §8：不再由本文件自己用角色字面量决定数据范围。规则只有一份（shared/rbac.ts），
    // 这里只把规则翻译成 SQL 条件。三个布尔与下面 permClauses 的结构保持原样 ——
    // 这是一次**机械等价替换**，不改 SQL 形状。
    // §3：连"读取角色范围"这件小事也走 AuthorizationService，
    // 于是"谁的范围是什么"在全仓只有一个入口。
    const scope = this.authz.subjectScopeOf(roles);
    const hasPrekHead = scope.wholePrograms.includes('prek');
    const hasKHead = scope.wholePrograms.includes('k');
    const hasPeSpecialist = scope.explicitPairs.length > 0;

    // 如果指定了 program + subject，先检查角色级权限
    if (program && subject) {
      if (hasPrekHead && program === 'prek') return sql`true`;
      if (hasKHead && program === 'k') return sql`true`;
      if (roleScopeCovers(scope, program, subject)) return sql`true`;
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

    // 明细权限：读取实现只有一份，在 AuthorizationService（§3）。
    const permRows = await this.authz.subjectPermissionRowsFor(teacherId, 'view', {
      program,
      subject,
    });

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

  /**
   * `subject_permissions` 的读取（§3）。
   *
   * 这原本是本文件里的**第三份**同款查询 —— 与 `AuthorizationService.hasSubjectPermission`
   * 逐行等价（连"只配了父科目时的回落"都一样）。三份同源实现意味着改一处漏两处，
   * 所以这里改为转发，实现只剩一份。
   */
  private async hasPermissionInDb(
    teacherId: string,
    program: string,
    subject: string,
    subSubject: string | undefined,
    action: 'view' | 'upload',
  ): Promise<boolean> {
    return this.authz.hasSubjectPermission(teacherId, program, subject, subSubject, action);
  }

  /**
   * 检查教师对指定科目的权限
   */
  /**
   * 科目级数据范围（§3）。
   *
   * 这里**不再有实现** —— 判定整体搬到了 `AuthorizationService.canAccessSubject`。
   * 本方法保留为薄转发，因为调用点有 5 处，全部改名只会放大这次改动的爆炸半径；
   * 而转发是等价的，且"实现只有一处"这个目标已经达成。
   *
   * 想改判定规则的人应该去 `AuthorizationService`，不要在这里加分支。
   */
  async checkSubjectPermission(
    teacherId: string,
    program: ProgramCode,
    subject: string,
    subSubject: string | undefined,
    action: 'view' | 'upload',
  ): Promise<boolean> {
    try {
      return await this.authz.canAccessSubject(
        teacherId,
        action,
        program,
        subject,
        subSubject,
      );
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
    // §1 目录过滤：把 code 解析成"该节点 + 全部子孙"的 id 集合。
    // 放在权限条件之后意味着它**只能进一步收窄**结果，永远不会放宽 ——
    // 因此"目录归属"不可能被用来绕过科目权限。
    if (params.directory) {
      const subtreeIds = await this.resolveDirectorySubtreeIds(params.directory);
      if (subtreeIds.length === 0) {
        throw new NotFoundException(`目录节点不存在：${params.directory}`);
      }
      conditions.push(inArray(resources.directoryId, subtreeIds));
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
        // §1 目录归属（与 folderType 是两个维度，两者都返回）。
        directoryId: item.directoryId ?? null,
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
    _ip?: string,
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
    // §1 目录过滤：把 code 解析成"该节点 + 全部子孙"的 id 集合。
    // 放在权限条件之后意味着它**只能进一步收窄**结果，永远不会放宽 ——
    // 因此"目录归属"不可能被用来绕过科目权限。
    if (params.directory) {
      const subtreeIds = await this.resolveDirectorySubtreeIds(params.directory);
      if (subtreeIds.length === 0) {
        throw new NotFoundException(`目录节点不存在：${params.directory}`);
      }
      conditions.push(inArray(resources.directoryId, subtreeIds));
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
      // §1 目录归属（与 folderType 是两个维度，两者都返回）。
      directoryId: item.directoryId ?? null,
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
    _ip?: string,
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
      // §1 目录归属（与 folderType 是两个维度，两者都返回）。
      directoryId: resource.directoryId ?? null,
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
    _ip?: string,
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
      // §1 目录归属（与 folderType 是两个维度，两者都返回）。
      directoryId: resource.directoryId ?? null,
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

  /**
   * 解析并校验一个目录归属（§1 / §3）。
   *
   * 规则（每一条都有明确理由，不是"顺手加的校验"）：
   *   1. `undefined` → 返回 null：不归属。**不猜默认目录** —— 把资源悄悄塞进
   *      "某个默认目录"会让用户以为是自己选的。
   *   2. 目录不存在 → 400（不是 404）：出错的是请求体里的一个字段，
   *      不是被请求的那条资源。
   *   3. `enabled = false` → 400：已停用的目录不接受新归属。
   *   4. 目录节点的 program 与资源的 program 不一致 → 400。
   *   5. 目录节点的规范 subject 与资源的 subject 不一致 → 400。
   *      4/5 合起来就是 §3 的"目录权限与 program/subject scope 同受约束"：
   *      资源本身的写入权限已经判过，归属又被钉在同一个 program+subject 上，
   *      因此**无法通过挑一个别的目录来绕开科目授权**。
   *
   * 子科与资料夹节点继承其所属科目，所以判定用的是 `subject` 列上记录的
   * 「所属科目 code」而不是节点自己的 code —— 与 directories.service 的
   * `subjectOwnerCodeFor` 同一套语义。
   */
  /**
   * 目录 code → 「该节点 + 全部子孙」的 id 列表（§1）。
   *
   * 为什么不递归 SQL：目录表只有几十行（实测 69 个节点、最深 4 层），
   * 一次全表读进来在内存里走一遍比递归 CTE 更好读、也更容易解释；
   * 真到了几千节点再换 CTE，那时这个函数的签名不用变。
   *
   * 返回空数组表示"没有这个 code" —— 调用方据此抛 404。
   * **绝不返回"全部"**：code 拼错时必须什么都查不到，而不是把整个库倒出来。
   */
  private async resolveDirectorySubtreeIds(code: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: directories.id, parentId: directories.parentId, code: directories.code })
      .from(directories);

    const target = rows.find((r) => r.code === code);
    if (!target) return [];

    const childrenOf = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      const list = childrenOf.get(row.parentId);
      if (list) list.push(row.id);
      else childrenOf.set(row.parentId, [row.id]);
    }

    const out: string[] = [];
    const stack: string[] = [target.id];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      out.push(id);
      for (const child of childrenOf.get(id) ?? []) stack.push(child);
    }
    return out;
  }

  /**
   * 校验并解析 `directoryId`，返回该节点（含 code / type / 祖先链）。
   *
   * 返回**整个节点**而不只是 id，是因为上传路径还要用它推导 legacy
   * `folderType`（§7 的服务端自动维护）—— 再查一次库既慢，也可能读到不同的快照。
   */
  private async resolveDirectoryAssignment(
    directoryId: string | undefined | null,
    program: string,
    subject: string,
    subSubject?: string,
    options: { requireLeafFolder?: boolean } = {},
  ): Promise<{
    id: string;
    code: string;
    name: string;
    type: string;
    /** 目录所处子科（`k:chinese:arts_*` → `arts`）；没有则为 null。 */
    ownerSubSubject: string | null;
    ancestorCodes: string[];
  } | null> {
    if (directoryId === undefined || directoryId === null || directoryId === '') return null;

    const rows = await this.db
      .select({
        id: directories.id,
        parentId: directories.parentId,
        code: directories.code,
        name: directories.name,
        type: directories.type,
        program: directories.program,
        subject: directories.subject,
        enabled: directories.enabled,
      })
      .from(directories)
      .where(eq(directories.id, directoryId))
      .limit(1);

    const node = rows[0];
    if (!node) {
      throw new BadRequestException('指定的目录不存在');
    }
    if (node.enabled === false) {
      throw new BadRequestException('该目录已停用，不能作为资源归属');
    }
    if (node.program !== null && node.program !== program) {
      throw new BadRequestException('资源与所选目录不属于同一班型');
    }

    /**
     * 新建资源只允许落在**资料夹叶节点**上（§4/§8）。
     *
     * 为什么必须限制：PDF 给每个教学叶节点规定的是
     * 课程大纲 / 教学详案 / 教学资源 / 考核评估 四个资料夹。
     * 若允许直接把资源挂到科目节点，界面上就会出现"这个科目有 3 条资源，
     * 但四个资料夹里一条都没有"—— 老师在目录里怎么点都找不到那 3 条。
     * 历史数据（`directory_id` 指向科目节点）不改，那是既有事实；
     * **新建不再产生这种形状**。
     */
    if (options.requireLeafFolder === true && node.type !== 'folder') {
      throw new BadRequestException(
        '资源必须放在具体资料夹下（课程大纲 / 教学详案 / 教学资源 / 考核评估，或资料夹下的自建文件夹）',
      );
    }

    /**
     * 所属科目**只能从 code 的路径结构推导**，不能读 `directories.subject` 列。
     *
     * ⚠️ 这里修掉的是一个真实缺陷，症状是"K 中文的四个子科全都传不上去"：
     *   `directories.subject` 对**子科下的资料夹**存的是**子科 token**，
     *   不是上级科目。实测：`k:chinese:arts_resource` 的 `subject` 是 `arts`，
     *   而资源的 `subject` 是上级科目 `chinese` —— 于是
     *   「资源与所选目录不属于同一科目」把一次完全合法的上传挡掉了。
     *   美育 / 古诗 / STEM / 绘本阅读 四个子科下的 16 个资料夹全部中招，
     *   而它们正是 `k:chinese` 的全部内容入口。
     *
     * code 的路径结构本身就把层级说清楚了：
     *   `prek:virtue_outline`        → 科目 `virtue`
     *   `k:chinese:arts_resource`    → 科目 `chinese`，子科 `arts`
     *   `prek:virtue_lesson.custom_x` → 科目 `virtue`（自建文件夹）
     * 所以取第 2 段做科目、第 3 段做子科，与 `shared/curriculum` 的词汇表对齐。
     */
    const pathSegments = node.code.split('.')[0].split(':');
    const ownerSubjectCode = pathSegments[1] ?? null;
    /**
     * 子科要从第 3 段里**剥掉资料夹后缀**再取。
     *
     * 因为子科与资料夹后缀挤在**同一段**里：`k:chinese:arts_resource` 的第 3 段是
     * `arts_resource`，而不是 `arts` + `resource` 两段（`prek:virtue_outline`
     * 同理，第 2 段是 `virtue_outline`）。
     * 第一版直接取第 3 段，于是拿到 `arts_resource` 与资源声明的 `arts` 一比就
     * 判成"不属于同一子科目" —— 和上面那个"科目取错列"是同一类错误的第二次出现：
     * **都把 code 的段数想当然了**。
     */
    const rawSubSubjectSegment = pathSegments.length >= 3 ? pathSegments[2] : null;
    const ownerSubSubjectCode =
      rawSubSubjectSegment === null
        ? null
        : node.type === 'sub_subject'
          ? rawSubSubjectSegment
          : // 资料夹：剥掉已知的资料夹后缀；剥不掉就当作子科名本身。
            (() => {
              const suffix = folderSuffixOf(node.code);
              if (suffix === null) return rawSubSubjectSegment;
              const tail = `_${suffix}`;
              return rawSubSubjectSegment.endsWith(tail)
                ? rawSubSubjectSegment.slice(0, -tail.length)
                : rawSubSubjectSegment;
            })();

    if (ownerSubjectCode !== null && ownerSubjectCode !== '') {
      const nodeSubject = canonicalSubjectOfDirectoryCode(ownerSubjectCode);
      if (nodeSubject !== null && nodeSubject !== subject) {
        throw new BadRequestException('资源与所选目录不属于同一科目');
      }
    }

    /**
     * 子科一致性：目标资料夹若在某个子科之下，资源声明的子科必须对得上。
     *
     * 只拦**明确冲突**的情况（调用方给了子科、且与目录不符）——
     * 调用方没给子科时不算冲突，由 createResource 用目录里的子科补齐，
     * 于是"老师只选了目录、没选子科目"也能正常保存，而不会保存出一条
     * "挂在美育资料夹下、子科却是古诗"的数据。
     */
    if (
      ownerSubSubjectCode !== null &&
      subSubject !== undefined &&
      subSubject !== null &&
      subSubject !== '' &&
      subSubject !== ownerSubSubjectCode
    ) {
      throw new BadRequestException('资源与所选目录不属于同一子科目');
    }

    return {
      id: node.id,
      code: node.code,
      name: node.name,
      type: node.type,
      /** 目录所处子科（没有则为 null）——供 createResource 补齐资源的 sub_subject。 */
      ownerSubSubject: ownerSubSubjectCode,
      ancestorCodes: await this.directoryAncestorCodes(node.parentId),
    };
  }

  /**
   * 从某个节点向上收集祖先 code（不含自己），**最多 16 层**并检测环。
   *
   * 上限与环检测不是防御性洁癖：`directories.parent_id` 是自引用外键，
   * 一次误操作就能造出一个环，而**这段代码跑在资源创建的写路径上** ——
   * 没有上限的话，一个环会让每次上传都挂死在这里，症状是"上传按钮转圈不返回"，
   * 与真正的原因（目录数据被改成环）相距极远。
   */
  private async directoryAncestorCodes(parentId: string | null): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = parentId;
    for (let depth = 0; cursor !== null && depth < 16; depth += 1) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const parentRows: { parentId: string | null; code: string }[] = await this.db
        .select({ parentId: directories.parentId, code: directories.code })
        .from(directories)
        .where(eq(directories.id, cursor))
        .limit(1);
      const row: { parentId: string | null; code: string } | undefined = parentRows[0];
      if (row === undefined) break;
      out.push(row.code);
      cursor = row.parentId;
    }
    return out;
  }

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

    // §1 目录归属：校验并解析 directoryId（不传 = 不归属）。
    //
    // 为什么校验放在这里而不是 DTO：需要查库、并且要**与资源自身的 program/subject 对齐**。
    //
    // 这个对齐就是 §3 要求的"目录权限必须同时受 directory/program/subject scope 约束"：
    // 资源能不能建，刚刚已经被 `checkSubjectPermission(..., 'upload')` 判过；
    // 而目录归属只允许落在**同一 program、同一 subject**的目录节点上，
    // 因此不可能用"选一个别的目录"来绕开科目授权。
    // 另外 `enabled = false`（已停用）的目录**不接受新归属** —— 停用就该是停用。
    const directoryAssignment = await this.resolveDirectoryAssignment(
      dto.directoryId,
      scope.program ?? dto.program,
      scope.subject ?? dto.subject,
      scope.subSubject,
      // 新建：必须是资料夹叶节点（见 resolveDirectoryAssignment 的说明）。
      { requireLeafFolder: true },
    );
    const directoryId = directoryAssignment?.id ?? null;

    /**
     * legacy `folder_type` 由服务端从目录推导（§7）。
     *
     * 优先用"目录 → 官方资料夹"这条（§9 的映射表，只有一份，见
     * `server/modules/directories/legacy-folder-mapping.ts`）；
     * 自建文件夹沿祖先链找最近的官方资料夹。
     *
     * **推不出来就报错，不猜**。编一个值写进库，等于把一个错误的分类
     * 永久固化进历史数据 —— 而那正是 §9 要求"如实报告、不要强行猜"的对象。
     */
    const derivedFolderType =
      directoryAssignment === null
        ? null
        : (folderTypeFromDirectoryNode({
            code: directoryAssignment.code,
            name: directoryAssignment.name,
            type: directoryAssignment.type,
          }) ?? folderTypeForCustomFolder(directoryAssignment.ancestorCodes));

    const effectiveFolderType = dto.folderType ?? derivedFolderType;
    if (effectiveFolderType === null || effectiveFolderType === undefined) {
      throw new BadRequestException(
        '无法为该目录推导历史资料夹分类；请显式提供 folderType（该目录不在官方四类资料夹之下）',
      );
    }

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
        // 子科：调用方给了就用它（一致性已在校验里拦过），没给就用**目录所处子科**。
        // 这样"只选了目录"的保存不会丢掉子科信息 —— 否则资源会落在美育资料夹下
        // 却没有子科，按子科筛选时找不到它。
        subSubject: scope.subSubject ?? directoryAssignment?.ownerSubSubject ?? undefined,
        // legacy 资料夹分类：由目录推导（§7）。两个维度并存，但这一维不再由用户填。
        folderType: effectiveFolderType,
        // §1 新的目录归属维度。
        directoryId,
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

      // §15：创建也是一次版本 —— 它的第 1 版。没有这一行，历史里就只有"改过之后"
      // 的版本，第 1 版永远缺席（回填那次是给迁移前既有数据补的，不适用于新资源）。
      await this.insertVersionSnapshot(newResource, {
        changeKind: 'created',
        changedBy: currentTeacherId,
      });

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
        // §1 目录归属（与 folderType 是两个维度，两者都返回）。
        directoryId: newResource.directoryId ?? null,
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

  /**
   * 写入一条版本快照（§15）。
   *
   * 由「行本身」生成快照，而不是由调用方拼字段：这样快照与 resources 行永远同构，
   * 新增一个可编辑列时不需要在多个地方记得同步 —— 忘记同步正是"字段悄悄不记录"的成因。
   */
  private async insertVersionSnapshot(
    row: typeof resources.$inferSelect,
    opts: { changeKind: string; changedBy: string },
  ): Promise<void> {
    await this.db.insert(resourceVersions).values({
      resourceId: row.id,
      version: row.version,
      title: row.title,
      titleEn: row.titleEn,
      description: row.description,
      folderType: row.folderType,
      semester: row.semester,
      weekNumber: row.weekNumber,
      theme: row.theme,
      fileBucketId: row.fileBucketId,
      filePath: row.filePath,
      fileName: row.fileName,
      fileSize: row.fileSize,
      fileType: row.fileType,
      status: row.status,
      changeKind: opts.changeKind,
      changedBy: opts.changedBy,
    });
  }

  /** 某个资源的版本历史，新的在前（§15）。 */
  async listVersions(resourceId: string, currentTeacherId: string): Promise<ResourceVersion[]> {
    const rows = await this.db
      .select()
      .from(resources)
      // 与其它读取一致：回收站里的资源先恢复再谈历史
      .where(and(eq(resources.id, resourceId), this.activeOnly()))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }

    // 历史能看到的人 == 能看到这个资源的人：同一套判定，避免"看不到资源却能看到它的历史"
    const isAdmin = await this.isAdminTeacher(currentTeacherId);
    const isUploader = rows[0].uploaderId === currentTeacherId;
    if (!isAdmin && !isUploader) {
      const allowed = await this.checkSubjectPermission(
        currentTeacherId,
        rows[0].program as never,
        rows[0].subject,
        rows[0].subSubject ?? undefined,
        'view',
      );
      if (!allowed) {
        throw new ForbiddenException('无权查看该资源的版本历史');
      }
    }

    const versions = await this.db
      .select()
      .from(resourceVersions)
      .where(eq(resourceVersions.resourceId, resourceId))
      .orderBy(desc(resourceVersions.version));

    return versions.map((v) => ({
      id: v.id,
      resourceId: v.resourceId,
      version: v.version,
      title: v.title,
      titleEn: v.titleEn ?? undefined,
      description: v.description ?? undefined,
      folderType: v.folderType as never,
      semester: v.semester ?? undefined,
      weekNumber: v.weekNumber ?? undefined,
      theme: v.theme ?? undefined,
      fileName: v.fileName ?? undefined,
      fileSize: v.fileSize ?? undefined,
      fileType: v.fileType ?? undefined,
      hasFile: Boolean(v.fileBucketId?.trim() && v.filePath?.trim()),
      status: v.status as never,
      changeKind: v.changeKind as never,
      changedBy: v.changedBy,
      changedAt: v.changedAt instanceof Date ? v.changedAt.toISOString() : String(v.changedAt),
    }));
  }

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
      // 内容变化才产生新版本（§15）。
      //
      // 判据是"patch 里有没有真的改到东西"，而不是"有没有发这个请求" ——
      // 后者会让每次无意义的保存都凭空造出一个版本，历史会被噪声淹没。
      // 比较用的是**存库后的形态**（例如 theme 已解析成 `主题1：我自己`），
      // 所以 `theme=myself` 与库里已有的值相等时不会算作变化。
      const contentKeys = Object.keys(patch) as Array<keyof typeof resources.$inferInsert>;
      const changedKeys = contentKeys.filter((k) => {
        const before = (resource as Record<string, unknown>)[k as string] ?? null;
        const after = (patch as Record<string, unknown>)[k as string] ?? null;
        return before !== after;
      });
      const fileKeys = ['fileBucketId', 'filePath', 'fileName', 'fileSize', 'fileType'];
      const touchesFile = changedKeys.some((k) => fileKeys.includes(k as string));
      const shouldVersion = changedKeys.length > 0;

      const updated = await this.db
        .update(resources)
        .set(shouldVersion ? { ...patch, version: resource.version + 1 } : patch)
        .where(eq(resources.id, id))
        .returning();

      const updatedResource = updated[0];

      if (shouldVersion) {
        // 快照写入失败会让整个编辑回滚（与审计同一策略）：宁可让编辑失败，
        // 也不要出现"版本号动了、却没有对应历史"的账。
        await this.insertVersionSnapshot(updatedResource, {
          changeKind: touchesFile ? 'file_attached' : 'metadata_edited',
          changedBy: currentTeacherId,
        });
      }

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
        // §1 目录归属（与 folderType 是两个维度，两者都返回）。
        directoryId: updatedResource.directoryId ?? null,
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
        // §1 目录归属（与 folderType 是两个维度，两者都返回）。
        directoryId: item.directoryId ?? null,
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

  /**
   * 按需永久删除**回收站里**的一条资源（§12 收口：`resource.purge` 从幽灵权限变成真能力）。
   *
   * WHY THIS EXISTS
   *   `purgeExpiredResources()` 只在"保留期到期"时清理，而**没有任何入口**
   *   能立刻永久删除一条指定资源 —— `resource.purge` 声明在权限目录里、
   *   服务层注释还提到它，却从来没有被任何路由或守卫检查过（幽灵权限）。
   *   后果是一个真实的运维缺口：误传的文件只能等 30 天。
   *
   * 三道闸，都是为了让"清理"不可能变成"误删业务数据"：
   *   1. 路由要求 `resource.purge` —— 权限目录里**只有 super_admin** 持有它；
   *   2. 只接受**已经在回收站里**的行（`deleted_at IS NOT NULL`）。
   *      正常资源必须先走"删除 → 回收站"，这条路径不能成为绕过回收站的近道；
   *   3. 必须写明 `reason`，与操作者、原来的 purge_after 一起进审计。
   *
   * 诚实的限制（写在这里，不藏）：本仓库的 `ObjectStorage` 抽象**只有**
   * `isConfigured()` 与 `createSignedUrl()`，**没有删除对象的能力**。
   * 所以本方法只删数据库行；桶里的对象会变成孤儿。这与既有的到期清理
   * （`purgeExpiredResources`）行为一致，那里也在审计里明写了同一句。
   * 要真正连对象一起删，需要先给存储抽象加一个 delete —— 那是另一件事。
   */
  async purgeResource(
    id: string,
    currentTeacherId: string,
    reason: string,
    ip?: string,
  ): Promise<{ purged: boolean; hadFile: boolean }> {
    const trimmed = (reason ?? '').trim();
    if (trimmed.length < 4) {
      throw new BadRequestException('必须写明清理原因（至少 4 个字），它会进审计记录');
    }

    const rows = await this.db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('资源不存在');
    }
    const resource = rows[0];

    // 闸 2：只允许清理**已进回收站**的行。
    if (resource.deletedAt === null) {
      throw new BadRequestException(
        '只能永久删除已在回收站中的资源。请先执行删除（移入回收站），再 purge —— ' +
          '这条路径不允许绕过回收站直接销毁正常资源。',
      );
    }

    const hadFile = Boolean(resource.fileBucketId && resource.filePath);

    // ⚠️ 这一步**必须**在 `authenticated_` 角色下做。
    //
    // `resources` 启用了 RLS，而策略里**没有**给 `anon_` 授予 DELETE
    // （只有 SELECT / INSERT / UPDATE）。每个 HTTP 请求默认以 `anon_` 执行 SQL，
    // 于是 `DELETE FROM resources` **静默影响 0 行** —— 不报错、不回滚，
    // 而紧接着写的审计却会说"已永久删除"。那是一条**假的审计记录**，
    // 比没有审计更糟：事后复核会以为删干净了。
    //
    // 实测（本机，同一行）：
    //     set local role anon_;          DELETE -> 影响 0 行，行仍在
    //     set local role authenticated_; DELETE -> 影响 1 行，行消失
    //
    // 这一点是我自己的行为测试抓出来的（`verify-resource-purge.mjs` 里
    // "数据库里那一行确实不存在了" 那条先红），不是靠读代码发现的。
    // 顺带确认：**到期清扫没有这个问题** —— 调度器跑在属主连接上
    // （不 SET ROLE），RLS 对属主不生效，所以它真的删得掉。
    // 回调拿到的是**裸**事务（只有 unsafe），不是 drizzle 查询对象 ——
    // 这是 rbac-write-context 的设计：只有裸 client 发出的语句才不会被打上
    // `SET LOCAL ROLE 'anon_'` 前导，显式切角色才有可能。
    const affected = await withRbacWriteContext(this.db, currentTeacherId, async (tx) => {
      const res = (await tx.unsafe('DELETE FROM resources WHERE id = $1', [id])) as unknown as {
        count?: number;
        length?: number;
      };
      return typeof res?.count === 'number' ? res.count : res?.length ?? 0;
    });
    if (affected === 0) {
      // 影响 0 行 = 没删掉。**必须抛错**，否则审计会记下一件没发生的事。
      throw new ServiceUnavailableException(
        `永久删除未生效（影响 0 行）。这通常意味着执行角色缺少 DELETE 权限 —— ` +
          `请检查 resources 表上的 RLS 策略是否覆盖 authenticated_。资源 ${id} 未被删除。`,
      );
    }

    const teacherInfo = await this.getTeacherById(currentTeacherId);
    await this.logAudit({
      action: 'resource_purge',
      teacherId: currentTeacherId,
      teacherName: teacherInfo?.name,
      resourceId: resource.id,
      resourceTitle: resource.title,
      program: resource.program,
      subject: resource.subject,
      success: true,
      ipAddress: ip,
      detail:
        `按需永久删除（操作者=${teacherInfo?.name ?? currentTeacherId}；原因=${trimmed}；` +
        `原 purge_after=${resource.purgeAfter ? new Date(resource.purgeAfter).toISOString() : '未知'}；` +
        `deleted_at=${new Date(resource.deletedAt).toISOString()}）` +
        (hadFile
          ? '；⚠ 对象存储中的文件未删除（ObjectStorage 抽象无 delete 能力），已变为孤儿对象'
          : '；该资源没有文件'),
    });

    this.logger.warn(
      `purgeResource: permanently deleted ${resource.id} by ${currentTeacherId} (reason=${trimmed})`,
    );
    return { purged: true, hadFile };
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
  /**
   * 签发一个"客户端直传"的预签名 PUT URL（§4/§23）。
   *
   * 三条设计取舍，每一条都对应一个真实的失败模式：
   *
   * 1. **对象键由服务端决定**，不接受客户端传入。客户端能选键就意味着能覆盖
   *    任意对象（包括别人的文件）—— 那不是"上传"，那是"任意写"。
   *    键形如 `uploads/<resourceId>/<时间戳>-<清洗后的文件名>`：
   *    带 resourceId 便于按资源清理，带时间戳使同名重传不会互相覆盖。
   * 2. **没有直传能力就明确拒绝**（503），不退回"假装上传成功"。
   *    这个项目此前正是在这里编造 `placeholder-bucket`，让行里声称有文件、
   *    下载却必然失败。
   * 3. **返回 bucketId 与 filePath**，客户端拿到后再调 `registerFile` 登记；
   *    登记时会做文件名清洗、类型/大小/魔数校验 —— 直传拿到 URL 不等于已被信任。
   */
  async createUploadUrl(
    resourceId: string,
    currentTeacherId: string,
    fileName: string,
    ip?: string,
  ): Promise<{ uploadUrl: string; bucketId: string; filePath: string; expiresInSeconds: number }> {
    const rows = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, resourceId), this.activeOnly()))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('资源不存在');

    const resource = rows[0];
    const isAdmin = await this.isAdminTeacher(currentTeacherId);
    if (!isAdmin && resource.uploaderId !== currentTeacherId) {
      throw new ForbiddenException('只有上传者本人或管理员可以上传该资源的文件');
    }

    if (typeof this.storage.createPresignedUploadUrl !== 'function') {
      throw storageUnavailable(STORAGE_NOT_CONFIGURED_CODE, STORAGE_NOT_CONFIGURED_MESSAGE);
    }
    if (!(await this.storage.isConfigured())) {
      throw storageUnavailable(STORAGE_NOT_CONFIGURED_CODE, STORAGE_NOT_CONFIGURED_MESSAGE);
    }

    const bucketId = this.configuredBucketId();
    if (bucketId === null) {
      throw storageUnavailable(STORAGE_NOT_CONFIGURED_CODE, STORAGE_NOT_CONFIGURED_MESSAGE);
    }

    const safeName = fileName.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 120) || 'file';
    const filePath = `uploads/${resourceId}/${Date.now()}-${safeName}`;
    const expiresInSeconds = 900;

    const uploadUrl = await this.storage.createPresignedUploadUrl({
      bucketId,
      filePath,
      ttlSeconds: expiresInSeconds,
    });

    await this.logAudit({
      action: 'resource_upload',
      teacherId: currentTeacherId,
      resourceId: resource.id,
      resourceTitle: resource.title,
      program: resource.program,
      subject: resource.subject,
      success: true,
      ipAddress: ip,
      detail: `签发直传地址：bucket=${bucketId} path=${filePath}（此后仍需 registerFile 校验并登记）`,
    });

    return { uploadUrl, bucketId, filePath, expiresInSeconds };
  }

  /**
   * 配置里的 bucket 名。
   *
   * 从 `S3_BUCKET` 读，与 `S3ObjectStorage` 用的是同一个环境变量 ——
   * 不在这里另立一套命名，否则"签名用的桶"和"登记的桶"会各说各话。
   */
  private configuredBucketId(): string | null {
    const bucket = (process.env.S3_BUCKET ?? '').trim();
    return bucket === '' ? null : bucket;
  }

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

    // --- storage availability, BEFORE anything is written --------------------
    //
    // 这是本轮补上的关键一行。在此之前 `registerFile` 只做"bucket 形状检查"
    // （非空、无路径穿越），于是**任何**客户端都能凭一个自己编的 bucket 名
    // 让这一行变成"有文件"：`resources.has_stored_file` 是由
    // 「path 与 bucket 都非空」生成的（migration 0008），所以行里立刻声称
    // 有可下载的文件，界面亮起"下载"，而下载必然 503。
    // 也就是把 object-storage.ts 明确要杜绝的"看起来能用、其实什么也没发生"
    // 往前挪了一步，只不过发生在写入侧。
    //
    // 现在：本进程没有对象存储后端 → 直接拒绝登记（503 STORAGE_NOT_CONFIGURED），
    // 不写任何文件列，并在审计里留下 file_validation_rejected。
    // 这与下载路径的判定完全一致（同一个 storage.isConfigured()）。
    if (!(await this.storage.isConfigured())) {
      await this.logAudit({
        action: 'file_validation_rejected',
        teacherId: currentTeacherId,
        resourceId: resource.id,
        resourceTitle: resource.title,
        program: resource.program,
        subject: resource.subject,
        success: false,
        ipAddress: ip,
        errorMessage: '对象存储未配置，拒绝登记文件（未写入任何文件列）',
        // 把"本来会写进去的东西"记进审计：校验通过后的规范化文件名与大小。
        // 这样"文件名被清洗过"这件事仍然**可被断言**（HTTP 套件从审计行读它），
        // 而不是因为成功路径变成 503 就丢掉这条证据。
        detail:
          `code=${STORAGE_NOT_CONFIGURED_CODE} backend=${this.storage.name} ` +
          `name=${validation.fileName} type=${validation.mimeType} ` +
          `detected=${validation.kind} size=${validation.sizeBytes} ` +
          `bucket=${input.fileBucketId} path=${bucketRelativePath}`,
      });
      throw storageUnavailable(STORAGE_NOT_CONFIGURED_CODE, STORAGE_NOT_CONFIGURED_MESSAGE);
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

    // §15：附加/替换文件是一次内容变化，理应产生新版本。
    // 这里再查一次行，是为了让快照来自**库里真实的样子**，而不是我拼的 patch。
    const afterFile = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.id, resourceId), this.activeOnly()))
      .limit(1);
    if (afterFile.length > 0) {
      const bumped = await this.db
        .update(resources)
        .set({ version: afterFile[0].version + 1 })
        .where(eq(resources.id, resourceId))
        .returning();
      if (bumped.length > 0) {
        await this.insertVersionSnapshot(bumped[0], {
          changeKind: 'file_attached',
          changedBy: currentTeacherId,
        });
      }
    }

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
        // §1 目录归属（与 folderType 是两个维度，两者都返回）。
        directoryId: updatedResource.directoryId ?? null,
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
        // §1 目录归属（与 folderType 是两个维度，两者都返回）。
        directoryId: item.directoryId ?? null,
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
    // is the only place the object-storage backend is called
    // (server/modules/files/object-storage.ts). No backend is configured in this
    // deployment, so that call cannot succeed: it fails with an explicit 503
    // (STORAGE_NOT_CONFIGURED), never with a silent success and never with a
    // fabricated URL.
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
  // ==========================================================================
  // §8 目录归属补齐（管理员）
  // ==========================================================================
  //
  // WHY THIS SECTION EXISTS
  // ----------------------
  // §9 的迁移报告（`LEGACY_RESOURCE_DIRECTORY_MIGRATION_REPORT.md`）实测出两个事实：
  //   · **1 条**资源的 `directory_id` 是 NULL（真正"未归属"）；
  //   · **348 条**资源挂在**科目/子科**节点上，而 PDF 规定资源应落在四个资料夹
  //     （课程大纲 / 教学详案 / 教学资源 / 考核评估）之下 ——
  //     也就是说它们"有归属，但精确不到资料夹"。
  //
  // 报告只报告、不改数据（§9 的要求）。改数据的入口就是这里：
  // 一个管理员视图 + 批量归档接口，让**人**决定那 349 条该去哪，
  // 而不是让一段迁移脚本替他们猜。
  //
  // 两个维度分开处理，是这一节最重要的设计约束：
  //   · `directory_id`（新维度）—— 本接口会改，这是它的职责；
  //   · `folder_type`（legacy 维度）—— **默认不动**。§9 明确"不要强行猜、
  //     不要篡改历史分类"。需要同步时由调用方显式开启 `syncLegacyFolderType`，
  //     且只在能从目标目录**推导出确定值**时才写。
  // ==========================================================================

  /**
   * 列出"待补齐"的资源：真正未归属的，以及只归档到科目层、没到资料夹的。
   *
   * `reason` 必须区分这两种情况 —— 它们的处理方式完全不同：
   * `unassigned` 要"选一个目录"，`subject_level` 要"往下再走一层到资料夹"。
   * 混成一个"未归档"标签，管理员会以为 349 条全都无处安放。
   */
  async listUnderFiledResources(
    params: { mode?: 'all' | 'unassigned' | 'subject_level'; page?: number; pageSize?: number } = {},
    teacherId?: string,
  ): Promise<UnderFiledListResponse> {
    const mode = params.mode ?? 'all';
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const subjectLevelIds = sql`(select id from directories where type in ('subject', 'sub_subject'))`;
    const nullClause = isNull(resources.directoryId);
    const subjectLevelClause = and(
      isNotNull(resources.directoryId),
      inArray(resources.directoryId, subjectLevelIds),
    );

    const reasonClause =
      mode === 'unassigned'
        ? nullClause
        : mode === 'subject_level'
          ? subjectLevelClause
          : or(nullClause, subjectLevelClause);

    const conditions: SQLWrapper[] = [this.activeOnly(), reasonClause as SQLWrapper];

    // 与其它读路径共用同一套数据范围判定：没有它，一个只被授了某个科目的账号
    // 也能在这里看到全园资源列表 —— 那是一个纯粹由"新页面忘了加条件"造成的越权。
    if (teacherId !== undefined) {
      const permCondition = await this.buildPermissionCondition(teacherId, undefined, undefined, undefined);
      if (permCondition === null) {
        return { items: [], total: 0, page, pageSize, counts: { unassigned: 0, subjectLevel: 0 } };
      }
      conditions.push(permCondition);
    }

    const whereClause = and(...conditions);

    const countResult = await this.db.select({ value: count() }).from(resources).where(whereClause);
    const total = countResult[0]?.value ?? 0;

    /**
     * 两个分组计数**单独查一次**，不受分页影响。
     * 界面要说的那句话是"349 条里有 1 条完全没归属、348 条只在科目层"，
     * 而当前页最多 20 条 —— 只统计当前页会把这句话说错。
     */
    const countByReason = await this.db
      .select({
        unassigned: sql<number>`count(*) filter (where ${resources.directoryId} is null)`,
        subjectLevel: sql<number>`count(*) filter (where ${resources.directoryId} is not null)`,
      })
      .from(resources)
      .where(whereClause);

    const items = await this.db
      .select({
        id: resources.id,
        title: resources.title,
        program: resources.program,
        subject: resources.subject,
        subSubject: resources.subSubject,
        folderType: resources.folderType,
        status: resources.status,
        updatedAt: resources.updatedAt,
        directoryId: resources.directoryId,
        directoryCode: directories.code,
        directoryName: directories.name,
        directoryType: directories.type,
      })
      .from(resources)
      // 左连接：`directory_id IS NULL` 的行也必须出现在结果里，
      // 用内连接会把**恰好是这一节主要对象**的那 1 条悄悄丢掉。
      .leftJoin(directories, eq(directories.id, resources.directoryId))
      .where(whereClause)
      // 先按"最容易补错"排：完全没归属的排前面，其次是科目层；
      // 同级按更新时间倒序（最近动过的更可能在等人补）。
      .orderBy(sql`${resources.directoryId} is not null`, desc(resources.updatedAt))
      .limit(pageSize)
      .offset(offset);

    return {
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        program: item.program,
        subject: item.subject,
        subSubject: item.subSubject ?? null,
        folderType: item.folderType,
        status: item.status,
        directoryCode: item.directoryCode ?? null,
        directoryName: item.directoryName ?? null,
        directoryType: item.directoryType ?? null,
        reason: item.directoryId === null ? 'unassigned' : 'subject_level',
        updatedAt: new Date(item.updatedAt).toISOString(),
      })),
      total,
      page,
      pageSize,
      counts: {
        unassigned: Number(countByReason[0]?.unassigned ?? 0),
        subjectLevel: Number(countByReason[0]?.subjectLevel ?? 0),
      },
    };
  }

  /**
   * 批量把资源归档到某个资料夹。
   *
   * 为什么是"逐条校验 + 一次 UPDATE + 校验影响行数"，而不是直接批量写：
   * 这个项目已经踩过一次同类坑 —— `resource.purge` 曾经在 `anon_` 角色下
   * 执行 `DELETE`，**实际影响 0 行**，而审计日志已经写下"已永久删除"。
   * 所以这里的规则是：**写入必须核对受影响行数**，对不上就抛错，
   * 绝不让"看起来成功"过去。
   */
  async assignResourcesToDirectory(
    input: {
      resourceIds: string[];
      directoryId: string;
      /** 是否同时把 legacy `folder_type` 改成从目标目录推导出的值。默认 false。 */
      syncLegacyFolderType?: boolean;
    },
    currentTeacherId: string,
    ip?: string,
  ): Promise<{ assigned: number; folderTypeUpdates: number; directoryCode: string }> {
    const uniqueIds = [...new Set(input.resourceIds)];
    if (uniqueIds.length === 0) {
      throw new BadRequestException('请至少选择一条资源');
    }

    // 目标目录：必须存在、启用、且是资料夹叶节点（与 createResource 同一口径）。
    const targetRows = await this.db
      .select({
        id: directories.id,
        code: directories.code,
        name: directories.name,
        type: directories.type,
        program: directories.program,
        subject: directories.subject,
        parentId: directories.parentId,
      })
      .from(directories)
      .where(eq(directories.id, input.directoryId))
      .limit(1);
    const target = targetRows[0];
    if (target === undefined) throw new BadRequestException('指定的目录不存在');
    if (target.type !== 'folder') {
      throw new BadRequestException('只能归档到资料夹（课程大纲 / 教学详案 / 教学资源 / 考核评估或自建文件夹）');
    }

    const targetFolderType = folderTypeFromDirectoryNode({
      code: target.code,
      name: target.name,
      type: target.type,
    }) ?? folderTypeForCustomFolder(await this.directoryAncestorCodes(target.parentId));

    const rows = await this.db
      .select({
        id: resources.id,
        program: resources.program,
        subject: resources.subject,
        subSubject: resources.subSubject,
        title: resources.title,
      })
      .from(resources)
      .where(and(this.activeOnly(), inArray(resources.id, uniqueIds)));

    // 少了行就说明有 id 不存在或已在回收站 —— 静默跳过会让界面显示
    // "已归档 12 条"而实际只动了 10 条。必须逐条说清楚。
    if (rows.length !== uniqueIds.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = uniqueIds.filter((id) => !found.has(id));
      throw new BadRequestException(
        `有 ${missing.length} 条资源不存在或已在回收站，未做任何改动：${missing.join(', ')}`,
      );
    }

    // 逐条校验：目标目录必须与该资源同 program、同 subject。
    // 与 createResource 用同一个断言口径（跨班型/跨科目的归档会把资源
    // 挪到用户看不见的地方，比"没归档"更糟）。
    for (const row of rows) {
      if (target.program !== null && target.program !== row.program) {
        throw new BadRequestException(`「${row.title}」与目标目录不属于同一班型`);
      }
      // 与 resolveDirectoryAssignment 同一条规则：**从 code 路径取科目**，
      // 不读 `directories.subject`（它对子科下的资料夹存的是子科 token，
      // 会让 K 中文四个子科的资料夹一律判定为"科目不符"）。
      const pathSegments = target.code.split('.')[0].split(':');
      const ownerSubjectCode = pathSegments[1] ?? null;
      if (ownerSubjectCode !== null && ownerSubjectCode !== '') {
        const nodeSubject = canonicalSubjectOfDirectoryCode(ownerSubjectCode);
        if (nodeSubject !== null && nodeSubject !== row.subject) {
          throw new BadRequestException(`「${row.title}」与目标目录不属于同一科目`);
        }
      }
      /**
       * 逐条再问一次科目权限：批量接口最容易变成权限旁路。
       *
       * 用 `'upload'` 而不是 `'view'`：这个操作**改变资源的可发现位置**，
       * 与"把资源放进这个科目"是同一类能力。`checkSubjectPermission` 的
       * 动作参数只有 view/upload 两种，而归档属于写操作 —— 选 upload。
       */
      const allowed = await this.checkSubjectPermission(
        currentTeacherId,
        row.program as ProgramCode,
        row.subject,
        row.subSubject ?? undefined,
        'upload',
      );
      if (!allowed) {
        throw new ForbiddenException(`无「${row.title}」所属科目的编辑权限`);
      }
    }

    const syncLegacy = input.syncLegacyFolderType === true && targetFolderType !== null;

    const updated = await this.db
      .update(resources)
      .set({
        directoryId: target.id,
        ...(syncLegacy ? { folderType: targetFolderType as string } : {}),
        updatedAt: new Date(),
      })
      .where(and(this.activeOnly(), inArray(resources.id, uniqueIds)))
      .returning({ id: resources.id });

    if (updated.length !== uniqueIds.length) {
      throw new Error(
        `归档影响行数不符：期望 ${uniqueIds.length}，实际 ${updated.length}（已回滚事务）`,
      );
    }

    await this.logAudit({
      action: 'resource_directory_assign',
      teacherId: currentTeacherId,
      program: target.program ?? undefined,
      subject: target.subject ?? undefined,
      success: true,
      ipAddress: ip,
      detail:
        `批量归档 ${updated.length} 条到「${target.name}」（${target.code}）` +
        (syncLegacy ? `，并同步 legacy folder_type → ${String(targetFolderType)}` : '，未改动 legacy folder_type'),
    });

    return {
      assigned: updated.length,
      folderTypeUpdates: syncLegacy ? updated.length : 0,
      directoryCode: target.code,
    };
  }

}
