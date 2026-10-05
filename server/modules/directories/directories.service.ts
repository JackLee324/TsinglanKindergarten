import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, count, eq, isNull } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/database/database.module';
import { directories, resources } from '@server/database/schema';
import type {
  DirectoryNode,
  DirectoryNodeType,
  DirectoryTreeResponse,
  ProgramCode,
  RoleCode,
} from '@shared/api.interface';
// 全部可见性规则来自 shared/rbac.ts —— 本模块**不写任何角色字面量**。
// 这是第六个同源缺陷点（ADMIN_ROLES 漏 super_admin）之后定下的约束：
// 「谁能看什么」只有一份实现。
import { isPlatformAdmin, programsVisibleForStructure, roleSubjectScope } from '@shared/rbac';
import { canonicalSubjectOfDirectoryCode, isKnownSubjectCode } from './directory-vocabulary';

/** `directories` 表的一行（只取本模块需要的列）。 */
interface DirectoryRow {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  nameEn: string;
  type: string;
  program: string | null;
  subject: string | null;
  sortOrder: number;
  allowCustomFolders: boolean;
}

interface VisibilityContext {
  /** null = 全部班型可见（平台管理员）。 */
  programsVisible: ProgramCode[] | null;
  scope: ReturnType<typeof roleSubjectScope>;
  hiddenSubjectCodes: string[];
}

/**
 * 目录树服务。
 *
 * WHY IT READS THE DATABASE INSTEAD OF A CONSTANT
 * -----------------------------------------------
 * 这棵树以前硬编码在三个前端文件里（PreKHomePage 的 PREK_SUBJECTS、KHomePage 的
 * K_SUBJECTS、PermissionAdminPage 自己那份），于是「改目录」= 改代码 + 重新发布，
 * 管理员在后台改不了任何东西。migration 0009 把它落成数据，本服务把它读出来。
 *
 * 关键约束（§1）：**本服务不做任何常量兜底**。数据库里没有的节点就不会出现，
 * 也不会悄悄用一份硬编码的旧结构顶上 —— 否则「管理员改了目录但页面没变」这类
 * 静默失败会重新出现。
 */
@Injectable()
export class DirectoriesService {
  private readonly logger = new Logger(DirectoriesService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /** 整棵目录树，按调用方角色过滤。 */
  async getTree(roles: RoleCode[] = []): Promise<DirectoryTreeResponse> {
    const rows = await this.loadAll();
    const childrenOf = this.indexByParent(rows);
    const counts = await this.loadResourceCounts();
    const context = this.visibilityFor(roles);

    const roots: DirectoryNode[] = [];
    for (const row of (childrenOf.get(null) ?? []).slice().sort(bySortOrder)) {
      const node = this.buildNode(row, childrenOf, counts, context);
      if (node !== null) roots.push(node);
    }

    context.hiddenSubjectCodes.sort();

    this.logger.debug(
      `directories tree: ${roots.length} root(s), ` +
        `${context.hiddenSubjectCodes.length} subject(s) hidden by scope`,
    );

    return {
      roots,
      customFolderLeafCount: rows.filter((r) => r.type === 'folder' && r.allowCustomFolders).length,
      hiddenSubjectCodes: context.hiddenSubjectCodes,
    };
  }

  /**
   * 单个节点（含整棵子树），用于「点进某个资料夹」的深链。
   *
   * 不可见与不存在返回**同一个** 404：区分二者等于告诉调用方「这个 code 存在，
   * 只是你权限不够」，把目录结构泄露给无权限的账号。
   */
  async getNodeByCode(code: string, roles: RoleCode[] = []): Promise<DirectoryNode> {
    const rows = await this.loadAll();
    const target = rows.find((r) => r.code === code);
    if (!target) {
      throw new NotFoundException(`目录节点不存在：${code}`);
    }

    const childrenOf = this.indexByParent(rows);
    const counts = await this.loadResourceCounts();
    const node = this.buildNode(target, childrenOf, counts, this.visibilityFor(roles));
    if (node === null) {
      throw new NotFoundException(`目录节点不存在：${code}`);
    }
    return node;
  }

  private visibilityFor(roles: RoleCode[]): VisibilityContext {
    return {
      programsVisible: isPlatformAdmin(roles) ? null : programsVisibleForStructure(roles),
      scope: roleSubjectScope(roles),
      hiddenSubjectCodes: [],
    };
  }

  /** 全部启用节点。 */
  private async loadAll(): Promise<DirectoryRow[]> {
    const rows = await this.db
      .select({
        id: directories.id,
        parentId: directories.parentId,
        code: directories.code,
        name: directories.name,
        nameEn: directories.nameEn,
        type: directories.type,
        program: directories.program,
        subject: directories.subject,
        sortOrder: directories.sortOrder,
        allowCustomFolders: directories.allowCustomFolders,
      })
      .from(directories)
      .where(eq(directories.enabled, true))
      .orderBy(directories.sortOrder, directories.code);

    return rows as DirectoryRow[];
  }

  /**
   * 已发布资源数，按 `resources` 的 (program, subject) 聚合。
   *
   * 为什么不是按 directory_id：migration 0009 是**纯加法**的，`resources` 还没有
   * `directory_id` 列 —— 6 种 folder_type → PDF 4 种资料夹的映射待业主确认
   * （docs/DIRECTORY_SPEC.md §2.1）。所以今天只能按 (program, subject) 聚合。
   *
   * 详见 resourceCountFor()：只有科目节点的数字是真实的。
   */
  private async loadResourceCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        program: resources.program,
        subject: resources.subject,
        total: count(),
      })
      .from(resources)
      .where(and(isNull(resources.deletedAt), eq(resources.status, 'published')))
      .groupBy(resources.program, resources.subject);

    const byKey = new Map<string, number>();
    for (const row of rows) {
      byKey.set(`${row.program ?? ''}:${row.subject ?? ''}`, Number(row.total));
    }
    return byKey;
  }

  private indexByParent(rows: DirectoryRow[]): Map<string | null, DirectoryRow[]> {
    const map = new Map<string | null, DirectoryRow[]>();
    for (const row of rows) {
      const list = map.get(row.parentId);
      if (list) list.push(row);
      else map.set(row.parentId, [row]);
    }
    return map;
  }

  /**
   * 递归构造节点；不可见返回 null（父节点据此整枝剪掉）。
   *
   * 顺序很重要：**先建子节点，再决定父节点是否可见**。根节点的可见性不是自己说了算 ——
   * `root:edu` 对 pe_specialist 应当出现（他看得到体能），对没有任何班型结构权限的账号
   * 应当整根消失。若先判父后建子，就会出现「一个没有任何可见子节点的空根」，
   * 页面上是个点不进去的空壳。
   */
  private buildNode(
    row: DirectoryRow,
    childrenOf: Map<string | null, DirectoryRow[]>,
    counts: Map<string, number>,
    context: VisibilityContext,
  ): DirectoryNode | null {
    const childRows = (childrenOf.get(row.id) ?? []).slice().sort(bySortOrder);
    const children: DirectoryNode[] = [];
    for (const child of childRows) {
      const node = this.buildNode(child, childrenOf, counts, context);
      if (node !== null) children.push(node);
    }

    if (!this.isNodeVisible(row, children, context)) {
      // 只在科目/子科层记录「因权限被剪掉」，供前端区分「无权限」与「无数据」。
      if (row.type === 'subject' || row.type === 'sub_subject') {
        context.hiddenSubjectCodes.push(row.code);
      }
      return null;
    }

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      nameEn: row.nameEn,
      type: row.type as DirectoryNodeType,
      program: row.program as ProgramCode | null,
      subject: this.canonicalSubjectFor(row),
      sortOrder: row.sortOrder,
      allowCustomFolders: row.allowCustomFolders,
      resourceCount: this.resourceCountFor(row, counts),
      children,
    };
  }

  /** 这个节点对调用方是否可见。`children` 是**已经过滤过**的子节点。 */
  private isNodeVisible(
    row: DirectoryRow,
    children: DirectoryNode[],
    context: VisibilityContext,
  ): boolean {
    // 教师成长分支不属于任何班型：它是所有已登录教师都能看到的职业成长路径说明，
    // 不涉及任何资源数据，因此不叠加科目范围判断（只要求已通过 AuthGuard）。
    if (row.code === 'root:growth' || row.code.startsWith('growth:')) return true;

    // 根 / 分组 / **班型**节点：它们本身不是权限对象，有可见子节点才可见。
    //
    // 班型节点必须一起处理 —— 第一版漏了 `program`，于是 pe_specialist 下
    // `prek:pe` 自己判定为可见、却因为它父节点 `prek` 被剪掉而整枝消失。
    // 症状很有迷惑性：单节点接口 `?code=prek:pe` 返回 200（不经过父节点），
    // 而树接口里连 `root:edu` 都不见了 —— 看起来像权限算错，其实是剪枝顺序错。
    if (row.code.startsWith('root:') || row.type === 'section' || row.type === 'program') {
      return context.programsVisible === null || children.length > 0;
    }

    const program = row.program as ProgramCode | null;
    if (program === null) return true;

    // 1. 平台管理员（principal / curriculum_director / super_admin）：全部
    if (context.programsVisible === null) return true;

    // 2. 整班型可见（prek_head / k_head；配班看结构）—— 与 CurriculumService 同一套语义，
    //    同样来自 shared/rbac.ts 的 programsVisibleForStructure，本文件不写角色字面量。
    if (context.programsVisible.includes(program)) return true;

    // 3. 单科目点授（今天只有 pe_specialist → physical_education）。
    //    失败关闭：认不出来的科目 code 不会走到这一步被放开。
    const ownerCode = this.subjectOwnerCodeFor(row);
    if (ownerCode !== null && isKnownSubjectCode(ownerCode)) {
      const token = canonicalSubjectOfDirectoryCode(ownerCode);
      if (
        token !== null &&
        context.scope.explicitPairs.some((p) => p.program === program && p.subject === token)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * 节点所属的「科目 code」。
   *
   * 资料夹/子科节点不带自己的科目归属列，要从 code 推：
   *   subject      → 自己
   *   sub_subject  → 自己（如 `k:chinese:reading`）
   *   folder       → `<科目 code>_<后缀>` 去掉最后的 `_后缀`
   *
   * 用 **lastIndexOf('_')** 而不是 split('_')：将来科目 code 里可能含 `_`，
   * 但四个后缀（outline / lesson / resource / assessment）一定不含，
   * 所以最后一个下划线是唯一可靠的分界。
   */
  private subjectOwnerCodeFor(row: DirectoryRow): string | null {
    if (row.type === 'subject' || row.type === 'sub_subject') return row.code;
    if (row.type === 'folder') {
      const idx = row.code.lastIndexOf('_');
      return idx === -1 ? null : row.code.slice(0, idx);
    }
    return null;
  }

  /**
   * 该节点对应的规范 subject token（授权用的那一套）。
   *
   * 科目节点查自己；子科与资料夹查其所属科目 —— 授权粒度就是 program+subject，
   * 所以资料夹应当继承科目的 token。
   *
   * `row.subject` 列**刻意不参与**这个判断：它的用途是将来把 `resources` 接到目录上时
   * 做 (program, subject) 反查，与「这个节点是哪个规范科目」是两件事。
   * 完整考证见 directory-vocabulary.ts 头部与 docs/DIRECTORY_SPEC.md §2.2。
   */
  private canonicalSubjectFor(row: DirectoryRow): string | null {
    if (row.type === 'sub_subject') {
      // 子科返回**自己**的规范 token：`k:chinese:reading` → picture_books。
      // PDF 新增的 `k:chinese:arts`（美育）在规范词汇里没有对应 token，因此返回 null ——
      // 这正是「PDF 要求了一个应用没有的科目」这个缺口在接口上的如实体现，
      // 而不是把它伪装成父科目 `chinese` 的 token。
      // 授权判定不读这个字段（见 isNodeVisible），所以返回 null 不会放开任何权限。
      return isKnownSubjectCode(row.code) ? canonicalSubjectOfDirectoryCode(row.code) : null;
    }
    const ownerCode = this.subjectOwnerCodeFor(row);
    if (ownerCode === null) return null;
    return isKnownSubjectCode(ownerCode) ? canonicalSubjectOfDirectoryCode(ownerCode) : null;
  }

  /**
   * 资源数。
   *
   * 只有 `type = 'subject'` 给真实数字：`resources.subject` 存的是规范 token，
   * 所以必须用 vocabulary 把目录 code（`prek:pe`）换成 token
   * （`physical_education`）才能命中 —— 直接拿 code 去查会得到 0，而 0 会被
   * 渲染成「暂无资源」，正是这个项目已经踩过的那个坑（347 行数据看着是空的）。
   *
   * 子科与资料夹返回 0 并说明原因，而不是回退成「整个科目的总数」——
   * 后者是一个看起来像真的、其实是另一个数的数字。
   * 等 `resources.directory_id` 迁移落地后改为按 directory_id 精确统计。
   */
  private resourceCountFor(row: DirectoryRow, counts: Map<string, number>): number {
    if (row.type !== 'subject') return 0;
    if (!isKnownSubjectCode(row.code)) return 0;
    const token = canonicalSubjectOfDirectoryCode(row.code);
    if (token === null) return 0;
    return counts.get(`${row.program ?? ''}:${token}`) ?? 0;
  }
}

function bySortOrder(a: DirectoryRow, b: DirectoryRow): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.code.localeCompare(b.code);
}
