# IA_CONSOLIDATION_PLAN.md — 目录信息架构收口（进行中）

> 业主 16 节指令的执行底稿。**当前状态：未完成**。
> 结论仍是 `NOT READY FOR DELIVERY`，直到 §16 的验收条件全部满足。
> 本文档是后续轮次的durable memory：上下文丢失也不会丢目标。

---

## 0. 先承认一件事：我之前的"完成"是**按字面**完成的，不是按架构

我在前几轮把 §1 报成"完成"，依据是：migration 0012 落了 `resources.directory_id`、
目录页能增删改查、能下钻看资源。那些都是真的。

但业主这次复查指出的是更深的一层，而且**他说得对**：

> 目录功能虽然已经实现，但仍然没有把整个网页真正切换到"数据库驱动目录"架构。

我用代码核对了他的每一条指控（见 §1），**全部成立**。真实情况是：
我**新增了一棵数据库目录树**，让 `/directory` 变成一个**管理树**，
却让**原有的课程导航页面继续读静态常量**。于是"目录"有两个真相：

```
数据库 directories 表  ──→ /directory（管理树）、上传页目录下拉
shared/curriculum.ts   ──→ Pre-K 首页、K 首页、科目页、主题页、侧边导航
```

管理员改了「美德」的名字，**只有前者变**。这正是业主说的
「目录页叫 A、首页叫 B、侧边栏叫 C」。我把它当成"两个维度并存"（legacy folderType
与 editable Directory），但业主的原意是 **Directory 必须是唯一真相**。

记录在这里，不辩解：**这是我的判读错误，不是遗漏。**

---

## 1. 代码级审计（本轮实测，不是转述业主的话）

| 指控 | 实测证据 | 成立 |
|---|---|---|
| 页面各自维护课程结构 | `PreKHomePage.tsx` / `KHomePage.tsx` 仍命中 `getCurriculumStructure` \| `CURRICULUM`；`PermissionAdminPage`、`UploadPage` 也在读静态常量 | ✅ |
| 只有两处用 Directory API | `grep -rln "getDirectoryTree" client/src/pages/` → 只有 `Directory/DirectoryPage.tsx` 与 `Upload/UploadPage.tsx` | ✅ |
| `/directory` 只是管理树 | `DirectoryPage.tsx` 里管理类控件（`onStartCreate`/`onStartRename`/`onDelete`/`data-dir-create`）命中 10 处；没有"卡片式浏览 → 资源列表"这一层 | ✅ |
| 系统目录被禁止改名 | `directories.service.ts:528` → `if (target.isSystem && wantsRename) throw new ForbiddenException('系统目录节点来自 PDF《教师平台》，不能改名…')` —— **这是我擅自加的限制，业主从未要求** | ✅ |
| 上传仍强制选 legacy folderType | `UploadPage.tsx:46` → `folderType: z.string().min(1, 'upload.folderRequired')`；`:230` → `form.trigger([... 'folderType'])` | ✅ |
| `directoryId` 不是必填 | `resources.dto.ts:183` `directoryId?: string`（可选）、`:228` `directoryId?: string \| null` | ✅ |

---

## 2. 目标架构（唯一真相链）

```
PostgreSQL directories 表
        │  GET /api/directories/tree（按角色剪枝）
        ▼
  一个前端数据层（client/src/directory/）
        │
        ├── 侧边导航（Layout）        ← 由树生成，不再写字面量
        ├── 首页卡片（Pre-K / K / 教师成长）  ← 由树生成，复用现有卡片视觉
        ├── 科目页 / 四目录卡片         ← 由树生成
        ├── 资源列表（按 directory 查询） ← 已有 ?directory= 接口
        ├── 上传页目录选择             ← 由树生成
        └── breadcrumb / 详情          ← 由树生成
```

**一个 Renderer 渲染所有层级。** 禁止为美德/蒙特梭利/中文/英文/体育/教师成长
各写一份 JSX 数组。

---

## 3. 工作项（按依赖排序，每项都要有测试）

### W1 — 目录节点名称全面可编辑（小、独立、先做）
* `directories.service.ts`：删除 `isSystem && wantsRename` 的 403；改为
  **只保护 code 与 is_system 标记**，`name` / `name_en` / `description` 对正式目录开放。
* `DirectoryNode` 暴露 `description`；审计沿用 `directory_rename`。
* 测试：`directories-write` 增"系统目录可改名 / code 不变"。

### W2 — 前端目录数据层（唯一入口）
* 新增 `client/src/directory/DirectoryProvider.tsx` + `useDirectory()`：
  一次 `getDirectoryTree()`，按 code 索引，提供
  `node(code)` / `childrenOf(code)` / `labelOf(code)` / `pathOf(code)` / `byLegacyPath(path)`。
* 名称来源**只有这里**。页面不再 import `shared/curriculum.ts` 的任何显示名。

### W3 — 单一 Directory Renderer（浏览模式）
* `client/src/directory/DirectoryBrowser.tsx`：给定一个节点，渲染
  * 有子节点 → **现有卡片样式**的网格（复用 `PreKHomePage` 卡片的外观，不新造视觉）
  * 是叶科/资料夹 → 资源列表（复用 `?directory=` 接口 + `ResourceCard`）
* `/directory` 保留管理模式，但默认进入**浏览模式**；
  `canManage` 时提供"管理模式"入口（链接或开关），不把两者混在一个界面里。

### W4 — 路由与兼容
* `/directory/:codePath`（如 `/directory/prek:virtue`）→ 浏览该节点。
* 旧 URL（`/prek/virtue`、`/k/chinese`、`/prek/montessori` …）**保留**，
  但实现改为：用 URL 段解析出 directory code → 交给 Renderer。
  **不得再有一份菜单/结构字面量。**
* 教师成长：`/growth`（或 `/directory/root:growth`）直达 L1/L2/L3 卡片。

### W5 — 侧边导航数据库驱动
* `Layout.tsx` 的 `menuItems` 字面量数组删掉；改为从 `useDirectory()` 取
  根的两个分支（教育教学 / 教师成长）+ 一级子节点。
* 权限可见性沿用现有 `hasPermission` / `programsVisibleForStructure` / `roleSubjectScope`
  （这部分之前已收口，保留）。

### W6 — 上传页：只选 Directory
* 删除 `folderType` 必填；表单只保留 program/subject（由目录推导）+ **directoryId 必填**。
* 服务端：`CreateResourceDto.directoryId` 改为**必填**；`resolveDirectoryAssignment`
  在缺省时 400（明确错误码，便于前端提示）。
* legacy `folderType` 由服务端按 mapping 自动维护：
  `curriculum_outline → 课程大纲`、`weekly_plans → 教学详案`、
  `courseware|materials → 教学资源`、`observation → 考核评估`；
  `research_archive` **无对应**，保留原值不猜。

### W7 — 历史资源迁移报告
* 新增 `scripts/report-legacy-directory-migration.mjs`：
  统计总数 / 已精确归档（到四目录之一）/ 仅归档到科目节点 / 无法判断，
  产出 `LEGACY_RESOURCE_DIRECTORY_MIGRATION_REPORT.md`。
* **只报告，不篡改**；有歧义的列出 id 与 program/subject/folderType 待人工决定。

### W8 — 未归属资源管理员视图 + 批量归档
* 接口：`GET /api/resources/unassigned`（`resource.view` + 管理员范围）、
  `POST /api/resources/assign-directory`（批量，`resource.update`）。
* 界面：`/admin/unassigned-resources`，可多选 → 选目录 → 批量归档。
* 必须在 W7 报告之后做，用报告决定归属规则。

### W9 — Permission Admin 收口
* 保留 `EffectivePermissionsPanel`；增加 **Scope 查看/编辑**
  （ALL / PROGRAM / SUBJECT / OWN），走已有 `AuthorizationService.setScopes`。
* `subject_permissions` 明确标注 legacy。

### W10 — data-export 标记为内部高危运维能力
* 前端不加入口；`DEPLOYMENT_PRODUCTION.md` 与接口注释写明 internal-only + 高危。
* 或加一个只有 super_admin 可见的运维页（默认不做，先标记）。

### W11 — 真实浏览器回归（新增套件）
`scripts/verify-ia-consolidation.mjs`（真实浏览器，进 `verify-all.sh`）：
1. Pre-K → 美德 → 课程大纲 → 资源（能进、能看到）
2. 管理员把「美德」改名为「美德课程」→ **硬刷新** → 侧边栏 / Pre-K 首页 /
   目录页 / 上传页**四处名称一致**；改回原名
3. 在允许自建的位置新增文件夹 → 刷新 → 目录显示 → 进入 → 上传资源 → 保存 →
   资源出现在该目录
4. 教师成长 → L1 → 安全施教规范 → 应急预案 → 传染病识别与防治

### W12 — 全量门禁 + 清理
`npm test` / typecheck / lint / build / 全部 HTTP suites / 全部 browser E2E；
再查 `git diff`、`git status`、dead code、duplicate definitions、TODO/FIXME/placeholder/mock。
工作区 clean。

---

## 4. 与业主 16 节的对应

| 业主节 | 由哪几项完成 |
|---|---|
| 1 最高原则 | 全程约束（不改视觉、不删功能） |
| 2 删除重复真相 | W2 + W3 + W5 |
| 3 浏览式 Renderer | W3 |
| 4 PDF 逐字匹配 | W1（允许自建位置）+ 数据校验（`directories` 现有 69 节点已对齐 PDF，见 `verify-directories.mjs`） |
| 5 名称可编辑 | W1 |
| 6 新增能力重新定义 | W1 + W3（管理入口）+ §6D 明确列为**后续能力**（新增科目型节点本轮不做，会在报告里写明） |
| 7 4 folder vs legacy 6 | W6 |
| 8 资源必须属目录 | W6 + W8 |
| 9 历史 347 条 | W7 + W8 |
| 10 教师成长一级 | W3 + W4 |
| 11 侧边导航数据库驱动 | W5 |
| 12 Permission Admin | W9 |
| 13 不得新重复数据 | W2 + W5 + W6（每类只有一个来源）+ §5 审计 |
| 14 data-export | W10 |
| 15 真实浏览器回归 | W11 |
| 16 最终验收 | W12 |

---

## 5. 明确**不做**的事（避免假装完成）

* **不新增科目型目录节点**（业主 §6D）：当前 `POST /api/directories/folder` 只能建
  `folder` 型节点，且必须在 `allowCustomFolders` 的父节点下。**新增一个全新"科目"
  节点（如某个班型下加一门课）本轮不实现**，会在最终报告里写成后续能力，
  不谎称"目录已完全可编辑"。
* **不改视觉**：卡片、配色、圆角、间距一律沿用现有；只换数据来源与层级组织。
* **不删除 legacy 字段**：`folderType`、`subject_permissions` 保留作兼容，
  但不作为新流程的选择项。
