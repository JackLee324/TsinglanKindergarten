# 清澜山幼儿园教师内部课程资源平台

## 项目概览
清澜山幼儿园教师内部课程资源平台，企业微信登录，RBAC 权限控制，Pre-K / K 双轨课程资源管理，文件上传下载与审核流程，中英双语。

## 技术栈
- 前端：React 19 + TypeScript + Tailwind CSS + shadcn/ui
- 后端：NestJS 10 + Drizzle ORM + PostgreSQL
- 登录：企业微信 OAuth 2.0（服务端 code 换 token）
- 会话：HttpOnly + Secure + SameSite Cookie
- 文件：dataloom storage + 服务端权限校验代理下载
- 双语：i18n context（zh-CN / en-US）

## 视觉设计规范

### 色彩系统（柔和紫色主题）
- 主色：柔和紫色 `#8B7EC8`（primary）
- 主色浅：`#B8AEDB`（primary-light）
- 主色深：`#6B5BAE`（primary-dark）
- 背景：`#FAF8FF`（极浅紫白）
- 卡片背景：`#FFFFFF`
- 文字主：`#2D2A3E`
- 文字次：`#6B6878`
- 边框：`#E8E4F0`
- 成功：`#7CB69C`
- 警告：`#E8B86B`
- 错误：`#D98B8B`

### 排版
- 标题：font-semibold，text-2xl（页面大标题）/ text-xl（区块标题）/ text-lg（卡片标题）
- 正文：text-base，leading-relaxed
- 辅助文字：text-sm，text-muted-foreground
- 字体：系统 sans-serif，中文优先

### 间距与布局
- 页面内容最大宽度：1280px，居中
- 卡片内边距：p-6
- 区块间距：gap-6（同级别卡片/区块间）
- 列表项间距：gap-3
- 圆角：rounded-xl（卡片）/ rounded-lg（按钮/输入框）/ rounded-full（标签/Badge）

### 组件风格
- 按钮：主按钮 bg-primary hover:bg-primary-dark text-white rounded-lg px-5 py-2
- 卡片：bg-white rounded-xl shadow-sm border border-[#E8E4F0]
- 输入框：rounded-lg border border-[#E8E4F0] focus:border-primary focus:ring-2 focus:ring-primary/20
- Badge：rounded-full px-3 py-1 text-xs font-medium
- 侧边导航：左侧固定宽度 240px，紫色渐变背景

### 响应式
- 桌面端：侧边栏 + 主内容区
- 平板：侧边栏可折叠
- 移动端：底部导航或顶部汉堡菜单

## 角色定义

| 角色标识 | 中文名 | 英文 | 说明 |
|---------|--------|------|------|
| principal | 园长/平台管理员 | Principal | 全部权限，教师/角色/权限管理 |
| curriculum_director | 教学主任/教研主管 | Curriculum Director | 审核发布、全部课程查看、教师权限分配 |
| prek_head | Pre-K 主教 | Pre-K Head Teacher | Pre-K 全部科目上传、提交审核 |
| k_head | K 主教 | K Head Teacher | K 全部科目上传、提交审核 |
| pe_specialist | 体能专科教师 | PE Specialist | 体能类科目上传、提交审核 |
| prek_assistant | Pre-K 配班/代课 | Pre-K Assistant | Pre-K 只读（可配置部分上传） |
| visitor | 普通访客/家长 | Visitor | 不能进入课程内容 |

## 班型与科目结构

### Pre-K
- 美德 Virtue
- 蒙特梭利 Montessori
  - 日常生活 Practical Life
  - 感官 Sensorial
  - 数学 Math
  - 英文语言 English Language
  - 中文语言 Chinese Language
  - 文化 Culture
- 体能 Physical Education

### K
- 美德 Virtue
- 中文 Chinese
  - 古诗 Ancient Poetry
  - 绘本 Picture Books
  - 戏剧 Drama
  - 科学与工程 STEM
- 英文 English（按 Big Unit Theme 组织）
  - Reading Comprehension
  - Language Skills
  - Math
- 体能 Physical Education
  - 体能专项 PE Special
  - 体育 Sports
  - 攀岩 Rock Climbing

### 资料夹（挂在末级科目/子科目下）
1. 课程大纲 Curriculum Outline
2. 周次教案 Weekly Lesson Plans
3. 课件与示范 Courseware & Demonstration
4. 素材与工作单 Materials & Worksheets
5. 观察与评价 Observation & Assessment
6. 教研归档 Teaching Research Archive

> §7 之后**老师不再自己选这 6 个之一**。上传时只选「所属目录」（目录树里的资料夹
> 叶节点），`folder_type` 由服务端按目录 code 的反缀推导
> （`server/modules/directories/legacy-folder-mapping.ts`）。
> `folder_type` 列**仍然存在**，审核台 / 回收站 / 我的资源仍在**显示**它 ——
> 那是历史分类的展示，不是分类入口。**不要把「资料夹」下拉加回上传页。**

## 资源状态
- draft 草稿
- pending_review 待审核
- published 已发布
- rejected 退回

## 学期与周次
- S1 = 第一学期 / Semester 1
- S2 = 第二学期 / Semester 2
- 每周编号 Week 1 ~ Week 20+
- 中文界面显示「第一学期 · 第 X 周」
- 英文界面显示「S1 · Week X」

## 数据库表设计
- teachers：教师账号（wecom_user_id、name、roles 数组、status）
- subject_permissions：教师-班型-科目权限
- resources：资源元数据（标题、班型、科目、资料夹、学期、周次、状态、版本、文件）
- review_records：审核记录
- audit_logs：审计日志（登录、拒绝、下载、上传、编辑、权限变更）

## 页面结构

### 公共页面
- /login 登录页（企业微信登录按钮）
- /unauthorized 未授权提示页
- /logout 退出

### 受保护页面
- / 首页 / Dashboard
- /directory 课程目录浏览根（教育教学 + 教师成长两个根）
- /directory/:path 任意目录节点（按 **directory code** 推导，如
  `/directory/prek/virtue`、`/directory/k/chinese/reading`）；科目层也列出其子树资源
- /directory/manage 目录管理（管理员：新建文件夹 / 改名 / 改英文名 / 改说明 / 停用 / 删除）
- /growth/:path 教师成长分支的一等入口（如
  `/growth/l1/safety/plan/disease`）；它是根节点 `root:growth`，地址前缀与教育教学**不同**
- /admin/unassigned-resources 待补齐目录归属（管理员）
- /upload 资源上传（需 `resource.create`；**必须选「所属目录」**）
- /my-resources 我的资源
- /admin/teachers 教师管理（`account.view`）
- /admin/permissions 权限管理（`permission.view`）
- /admin/audit 审计日志（`audit.view`）
- /review 审核工作台（`review.view`）

> ⚠️ **不要再新增 `/prek`、`/k`、`/virtue`、`/montessori` 这类旧地址页面。**
> 它们曾经各自持有**一份写死的科目数组**，是"第二份目录真相"的载体，已在信息架构
> 收口时连同页面文件一起删除（`client/src/pages/{PreKHome,KHome,Chinese,English,
> Montessori,PE,Subject}/`）。旧地址的兼容由 `client/src/directory/DirectoryRoutes.tsx`
> 的 `LegacyDirectoryRedirect` 负责（把 URL 反解回 directory code 再重定向），
> **不需要页面文件**。
>
> 目录的唯一真相是数据库 `directories` 表，经 `GET /api/directories/tree` 暴露；
> 前端只有一个 `client/src/directory/DirectoryProvider.tsx` 持有它，侧边栏
> （`Layout.tsx`）、目录浏览、面包屑、上传页「所属目录」、资源详情读的都是它。
> URL 由 `codeToPath()` **唯一**推导。改一个目录的中文名，侧边栏 / 首页卡片 /
> 面包屑 / 上传页下拉 / 资源详情会同时变 —— 这是验收项，不是巧合。
> 这条约束由 `tests/no-legacy-directory-truth.test.mjs` 强制（已做变异验证：
> 把一份"第二真相"放回去，它确实会红）。
>
> **权限判定用能力码**：路由用 `<ProtectedRoute requiredPermission="…">`，
> 后端用 `@RequirePermission('…')`，两侧同一份 `shared/rbac.ts`。
> **不要**在页面里写 `roles.includes('principal')` 或角色白名单数组。

## 其他已实现能力（容易漏读）
- 角色**数据范围**（`account_scopes`）：ALL / OWN / PROGRAM / SUBJECT 四种形态，
  在权限管理界面可视化编辑；非法形态由服务端在事务前拒绝（400），不是 500。
- 回收站：软删除 + 到期自动清理；`resource.purge` 是硬删除（需单独权限）。
- 审计日志：登录/拒绝/下载/上传/编辑/权限变更/数据导出都会落 `audit_logs`。


## 双语规范
- 中文模式下，除英文专业学科外，界面只显示中文
- 英文专业学科（English Language、Reading Comprehension 等）保留英文术语
- S1/S2 中文显示为"第一学期/第二学期"
- 资源"待补充"显示为"Not filled in source"（双语都保留）
