import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';
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
import { AuditLoggerService } from '@server/modules/audit/audit-logger.service';

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
  isSystem: boolean;
  createdBy: string | null;
  enabled: boolean;
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

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly audit: AuditLoggerService,
  ) {}

  /**
   * 整棵目录树，按调用方角色过滤。
   *
   * `canManage` 由控制器从**生效权限**传入（不是从 roles 推），前端据此决定
   * 是否显示"新建文件夹"入口 —— 服务端算错也不会越权，写接口另有 @RequirePermission。
   */
  async getTree(roles: RoleCode[] = [], canManage = false): Promise<DirectoryTreeResponse> {
    const rows = await this.loadAll();
    const childrenOf = this.indexByParent(rows);
    const counts = this.computeSubtreeCounts(rows, await this.loadResourceCounts());
    const context = this.visibilityFor(roles);

    const rowsById = new Map(rows.map((r) => [r.id, r]));

    const roots: DirectoryNode[] = [];
    for (const row of (childrenOf.get(null) ?? []).slice().sort(bySortOrder)) {
      const node = this.buildNode(row, childrenOf, rowsById, counts, context);
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
      canManage,
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
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    const counts = this.computeSubtreeCounts(rows, await this.loadResourceCounts());
    const node = this.buildNode(target, childrenOf, rowsById, counts, this.visibilityFor(roles));
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
  private async loadAll(includeDisabled = false): Promise<DirectoryRow[]> {
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
        isSystem: directories.isSystem,
        createdBy: directories.createdBy,
        enabled: directories.enabled,
      })
      .from(directories)
      // 读树时只取启用的节点（停用 = 从树上消失）；**写路径必须带上停用节点**，
      // 否则会出现一个死结：一旦停用，`loadAll()` 就再也找不到它，
      // 于是「重新启用」这个操作永远返回 404 —— 停用变成一次性不可逆的操作。
      .where(includeDisabled ? undefined : eq(directories.enabled, true))
      .orderBy(directories.sortOrder, directories.code);

    return rows as DirectoryRow[];
  }

  /**
   * 已发布资源数，**按 `resources.directory_id` 精确聚合**（migration 0012 落地后）。
   *
   * 之前不是这样的：那时没有 directory_id 列，只能按 (program, subject) 聚合，
   * 于是**只有科目节点的数字是真的**，子科与资料夹一律返回 0（并在注释里写明了
   * "等 resources.directory_id 迁移落地后改为按 directory_id 精确统计"）。
   * 现在那个前提已经满足，这里就换成精确统计 —— 每个节点都能给出属于自己的数字。
   *
   * 只统计 `published` 且未删除的资源，与之前的口径一致（回收站里的不算"平台上有"）。
   * 未归属（directory_id IS NULL）的资源不属于任何节点，因此不出现在任何数字里 ——
   * 这是事实，不是遗漏。
   */
  private async loadResourceCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        directoryId: resources.directoryId,
        total: count(),
      })
      .from(resources)
      .where(
        and(
          isNull(resources.deletedAt),
          eq(resources.status, 'published'),
          isNotNull(resources.directoryId),
        ),
      )
      .groupBy(resources.directoryId);

    const byId = new Map<string, number>();
    for (const row of rows) {
      if (row.directoryId === null) continue;
      byId.set(row.directoryId, Number(row.total));
    }
    return byId;
  }

  /**
   * 把"每个节点自己的资源数"累加成"整棵子树的资源数"。
   *
   * 为什么是子树而不是自己那一个节点：老师在科目页看到「美德 12」时，
   * 期望的是"这个科目下总共有 12 份"，而不是"正好挂在科目节点上、没进任何
   * 资料夹的那几份"。资料夹里的资源显然也属于这个科目。
   *
   * 按**完整**目录表累加（不按可见性剪枝后的树）：权限只决定"你能不能看到这个节点"，
   * 不改变"这个节点下有多少资源"这个事实。
   */
  private computeSubtreeCounts(
    rows: DirectoryRow[],
    own: Map<string, number>,
  ): Map<string, number> {
    const childrenOf = this.indexByParent(rows);
    const memo = new Map<string, number>();
    const visit = (row: DirectoryRow): number => {
      const cached = memo.get(row.id);
      if (cached !== undefined) return cached;
      let total = own.get(row.id) ?? 0;
      for (const child of childrenOf.get(row.id) ?? []) total += visit(child);
      memo.set(row.id, total);
      return total;
    };
    for (const row of rows) visit(row);
    return memo;
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
    rowsById: Map<string, DirectoryRow>,
    counts: Map<string, number>,
    context: VisibilityContext,
  ): DirectoryNode | null {
    const childRows = (childrenOf.get(row.id) ?? []).slice().sort(bySortOrder);
    const children: DirectoryNode[] = [];
    for (const child of childRows) {
      const node = this.buildNode(child, childrenOf, rowsById, counts, context);
      if (node !== null) children.push(node);
    }

    if (!this.isNodeVisible(row, children, rowsById, context)) {
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
      subject: this.canonicalSubjectFor(row, rowsById),
      sortOrder: row.sortOrder,
      allowCustomFolders: row.allowCustomFolders,
      isSystem: row.isSystem,
      enabled: row.enabled,
      resourceCount: this.resourceCountFor(row, counts),
      children,
    };
  }

  /** 这个节点对调用方是否可见。`children` 是**已经过滤过**的子节点。 */
  private isNodeVisible(
    row: DirectoryRow,
    children: DirectoryNode[],
    rowsById: Map<string, DirectoryRow>,
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
    const ownerCode = this.subjectOwnerCodeFor(row, rowsById);
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
   * 节点所属的「科目 code」—— **沿真实父子链向上找**，不解析 code 字符串。
   *
   * 第一版是按字符串推的（资料夹 code 形如 `<科目 code>_<后缀>`，取最后一个下划线之前
   * 的部分）。那在"只有种子数据"时是对的，但一旦允许管理员**自建**文件夹就立刻错：
   * 自建节点在 `prek:pe_lesson` 之下，code 是 `prek:pe_lesson_u1`，
   * lastIndexOf('_') 得到的是 `prek:pe_lesson`（一个 folder），
   * `isKnownSubjectCode` 判定为假 → 该节点对按科目点授的角色不可见。
   * 也就是说：**新建文件夹的人自己能看到，被授权该科目的同事看不到**。
   *
   * 父子链是数据本身，不受命名规则影响，所以这里改成沿 parent 上溯。
   * `rowsById` 由 loadAll() 建立，随每次请求传入。
   */
  private subjectOwnerCodeFor(
    row: DirectoryRow,
    rowsById: Map<string, DirectoryRow>,
  ): string | null {
    if (row.type === 'subject' || row.type === 'sub_subject') return row.code;
    let current: DirectoryRow | undefined = row;
    const seen = new Set<string>();
    while (current && current.parentId) {
      if (seen.has(current.id)) return null; // 数据异常时不要死循环
      seen.add(current.id);
      const parent: DirectoryRow | undefined = rowsById.get(current.parentId);
      if (!parent) return null;
      if (parent.type === 'subject' || parent.type === 'sub_subject') return parent.code;
      current = parent;
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
  private canonicalSubjectFor(row: DirectoryRow, rowsById: Map<string, DirectoryRow>): string | null {
    if (row.type === 'sub_subject') {
      // 子科返回**自己**的规范 token：`k:chinese:reading` → picture_books。
      //
      // 曾经 `k:chinese:arts`（美育）返回 null，因为规范词汇里没有它 ——
      // 那是「PDF 要求了一个应用没有的科目」这个缺口的如实体现。用户已决策
      // 「K Chinese Arts → k_head」，该子科已**正式纳入规范词汇**（key 'arts'），
      // 所以现在返回 'arts' 而不是 null，也不再需要把 null 当作"已知但非规范"的信号。
      return isKnownSubjectCode(row.code) ? canonicalSubjectOfDirectoryCode(row.code) : null;
    }
    const ownerCode = this.subjectOwnerCodeFor(row, rowsById);
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
    return counts.get(row.id) ?? 0;
  }

  // ===========================================================================
  // 写路径（§24/§25/§26）—— 「允许自建文件夹」
  // ===========================================================================
  //
  // 三条规则，全部在服务层判、且全部有数据库层兜底：
  //
  //   1. **只能建在允许自建的地方**：父节点 `allowCustomFolders = true`
  //      （PDF 明确标注的那 16 个叶节点），或者父节点本身就是自建文件夹
  //      （自建文件夹下允许再建，否则"自建"只有一层，实际用不了）。
  //      —— 这条不能在 UI 上"藏按钮"了事：接口必须自己拦。
  //   2. **只能改/删自建节点**：系统节点来自 PDF，是 §1 的验收基准。
  //      删掉一个系统节点 = 悄悄偏离 PDF，且事后无人知道少了什么。
  //      数据库层由 `directories_user_node_is_folder` 与 `is_system` 保证语义。
  //   3. **非空才能删**：有子节点的先删子节点，避免一次请求连带删掉整棵子树。
  //
  // 每一次写操作都写审计日志（directory_create / rename / delete）。

  /** 新建自建文件夹。 */
  async createFolder(
    input: { parentCode: string; name: string; nameEn?: string; description?: string },
    actor: DirectoryActor,
  ): Promise<DirectoryNode> {
    const parentCode = (input.parentCode ?? '').trim();
    const name = (input.name ?? '').trim();
    if (parentCode === '') throw new BadRequestException('缺少父节点 code');
    if (name === '') throw new BadRequestException('文件夹名称不能为空');
    if (name.length > 120) throw new BadRequestException('文件夹名称过长（最多 120 字）');

    const rows = await this.loadAll();
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    const parent = rows.find((r) => r.code === parentCode);
    if (!parent) throw new NotFoundException(`父节点不存在：${parentCode}`);

    // 规则 1
    const parentAllows =
      parent.allowCustomFolders || (parent.type === 'folder' && !parent.isSystem);
    if (!parentAllows) {
      throw new ForbiddenException(
        `「${parent.name}」不允许自建文件夹（PDF 只允许在部分资料夹下自建）`,
      );
    }

    // 同层重名：数据库有唯一索引兜底，但先给出可读的错误，而不是 500。
    const clash = rows.find(
      (r) => r.parentId === parent.id && r.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) throw new ConflictException(`同级下已存在同名文件夹「${name}」`);

    const code = await this.nextChildCode(parent, rows);
    const [created] = await this.db
      .insert(directories)
      .values({
        parentId: parent.id,
        code,
        name,
        nameEn: (input.nameEn ?? '').trim() || name,
        type: 'folder',
        program: parent.program,
        subject: parent.subject,
        sortOrder: this.nextSortOrder(parent, rows),
        allowCustomFolders: true, // 自建文件夹下允许继续自建（见规则 1）
        isSystem: false,
        createdBy: actor.teacherId ?? null,
        description: (input.description ?? '').trim() || null,
      })
      .returning();

    await this.audit.log('directory_create', {
      teacherId: actor.teacherId,
      teacherName: actor.teacherName,
      detail: `新建文件夹「${name}」于「${parent.name}」（${parent.code}）`,
    });

    const node = this.buildNode(
      created as DirectoryRow,
      this.indexByParent([...rows, created as DirectoryRow]),
      new Map([...rowsById, [(created as DirectoryRow).id, created as DirectoryRow]]),
      new Map(),
      { programsVisible: null, scope: roleSubjectScope([]), hiddenSubjectCodes: [] },
    );
    if (node === null) throw new InternalServerErrorException('新建成功但读取失败');
    return node;
  }

  /** 重命名 / 改描述 —— 只允许自建节点。 */
  async updateNode(
    code: string,
    input: {
      name?: string;
      nameEn?: string;
      description?: string;
      sortOrder?: number;
      enabled?: boolean;
    },
    actor: DirectoryActor,
  ): Promise<DirectoryNode> {
    // **必须带停用节点**：否则停用之后就再也找不到它，"重新启用"永远 404。
    const rows = await this.loadAll(true);
    const target = rows.find((r) => r.code === code);
    if (!target) throw new NotFoundException(`目录节点不存在：${code}`);

    // 改名/改描述受系统节点保护（它们来自 PDF，改名会让 PDF 与库里的名字对不上）；
    // 但**排序与启用/停用对所有节点开放** —— 这两件事不改任何业务含义：
    // 「这一学期不开这门课」是学校的正常操作，靠停用表达，而不是去改 PDF。
    const wantsRename =
      input.name !== undefined || input.nameEn !== undefined || input.description !== undefined;
    if (target.isSystem && wantsRename) {
      throw new ForbiddenException(
        '系统目录节点来自 PDF《教师平台》，不能改名；如需调整请先改 PDF 与种子数据',
      );
    }

    if (input.sortOrder !== undefined) {
      if (!Number.isInteger(input.sortOrder) || input.sortOrder < -100000 || input.sortOrder > 100000) {
        throw new BadRequestException('排序值必须是 -100000 到 100000 之间的整数');
      }
    }

    const name = input.name === undefined ? undefined : input.name.trim();
    if (name !== undefined) {
      if (name === '') throw new BadRequestException('文件夹名称不能为空');
      if (name.length > 120) throw new BadRequestException('文件夹名称过长（最多 120 字）');
      const clash = rows.find(
        (r) =>
          r.id !== target.id &&
          r.parentId === target.parentId &&
          r.name.toLowerCase() === name.toLowerCase(),
      );
      if (clash) throw new ConflictException(`同级下已存在同名文件夹「${name}」`);
    }

    const [updated] = await this.db
      .update(directories)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(input.nameEn === undefined ? {} : { nameEn: input.nameEn.trim() || name }),
        ...(input.description === undefined
          ? {}
          : { description: input.description.trim() || null }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        updatedAt: new Date(),
      })
      .where(eq(directories.id, target.id))
      .returning();

    if (wantsRename) {
      await this.audit.log('directory_rename', {
        teacherId: actor.teacherId,
        teacherName: actor.teacherName,
        detail: `重命名「${target.name}」→「${name ?? target.name}」（${target.code}）`,
      });
    }
    if (input.sortOrder !== undefined || input.enabled !== undefined) {
      const bits: string[] = [];
      if (input.sortOrder !== undefined) bits.push(`排序 ${target.sortOrder} → ${input.sortOrder}`);
      if (input.enabled !== undefined) bits.push(input.enabled ? '启用' : '停用');
      await this.audit.log('directory_update', {
        teacherId: actor.teacherId,
        teacherName: actor.teacherName,
        detail: `${bits.join('、')}「${target.name}」（${target.code}）`,
      });
    }

    const merged = rows.map((r) => (r.id === target.id ? (updated as DirectoryRow) : r));
    const node = this.buildNode(
      updated as DirectoryRow,
      this.indexByParent(merged),
      new Map(merged.map((r) => [r.id, r])),
      new Map(),
      { programsVisible: null, scope: roleSubjectScope([]), hiddenSubjectCodes: [] },
    );
    if (node === null) throw new InternalServerErrorException('更新成功但读取失败');
    return node;
  }

  /** 删除自建文件夹（必须无子节点）。 */
  async deleteNode(code: string, actor: DirectoryActor): Promise<void> {
    // 与 updateNode 同理：必须带停用节点，否则"停用过就永远删不掉"。
    const rows = await this.loadAll(true);
    const target = rows.find((r) => r.code === code);
    if (!target) throw new NotFoundException(`目录节点不存在：${code}`);
    if (target.isSystem) {
      throw new ForbiddenException('系统目录节点来自 PDF《教师平台》，不能删除');
    }
    const children = rows.filter((r) => r.parentId === target.id);
    if (children.length > 0) {
      throw new ConflictException(
        `「${target.name}」下还有 ${children.length} 个子文件夹，请先删除子文件夹`,
      );
    }

    // 删除保护（§1）：还有资源挂在这个节点上时拒绝删除。
    //
    // 数据库那层已经有 `ON DELETE RESTRICT` 兜底，但**只有数据库兜底是不够的**：
    // 外键冲突会以 Postgres 原始错误冒上来，用户看到的是 500「服务器内部错误」，
    // 既不知道原因也不知道该怎么办 —— 实测正是如此（删一个刚放过资源的自建目录）。
    // 所以这里先查一次，给出可执行的 409。
    //
    // 注意**不过滤 `deleted_at`**：回收站里的资源行还在，外键照样拦得住它，
    // 所以判断必须与数据库的真实约束一致，否则又会出现"接口说能删、数据库说不能"。
    const refRows = await this.db
      .select({ total: count() })
      .from(resources)
      .where(eq(resources.directoryId, target.id));
    const referenced = Number(refRows[0]?.total ?? 0);
    if (referenced > 0) {
      throw new ConflictException(
        `「${target.name}」下还有 ${referenced} 份资源（**含回收站里尚未清除的**），` +
          `不能删除。请先把这些资源改到别的目录，或等它们在回收站到期后被清理。`,
      );
    }

    await this.db.delete(directories).where(eq(directories.id, target.id));

    await this.audit.log('directory_delete', {
      teacherId: actor.teacherId,
      teacherName: actor.teacherName,
      detail: `删除自建文件夹「${target.name}」（${target.code}）`,
    });
  }

  /**
   * 下一个可用的子节点 code。
   *
   * 自建节点统一用 `<parentCode>_u<n>`。选择"可读且可判定来源"的形式，
   * 而不是随机串：出问题时一眼能看出是管理员建的还是种子里的。
   * 与既有后缀（outline/lesson/resource/assessment）不会冲突（那些不含 `_u`）。
   */
  private async nextChildCode(parent: DirectoryRow, rows: DirectoryRow[]): Promise<string> {
    const taken = new Set(rows.map((r) => r.code));
    for (let n = 1; n <= 999; n += 1) {
      const candidate = `${parent.code}_u${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new ConflictException('该文件夹下自建文件夹数量已达上限（999）');
  }

  private nextSortOrder(parent: DirectoryRow, rows: DirectoryRow[]): number {
    const siblings = rows.filter((r) => r.parentId === parent.id);
    return siblings.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 10;
  }
}

/** 写操作的操作者信息，仅用于审计。 */
export interface DirectoryActor {
  teacherId?: string;
  teacherName?: string;
}

function bySortOrder(a: DirectoryRow, b: DirectoryRow): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.code.localeCompare(b.code);
}
