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

### 六类资料夹（每个末级科目下）
1. 课程大纲 Curriculum Outline
2. 周次教案 Weekly Lesson Plans
3. 课件与示范 Courseware & Demonstration
4. 素材与工作单 Materials & Worksheets
5. 观察与评价 Observation & Assessment
6. 教研归档 Teaching Research Archive

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
- /prek Pre-K 首页（科目目录）
- /prek/:subject Pre-K 科目详情（资料夹列表 + 资源）
- /k K 首页（科目目录 + Theme 列表）
- /k/:subject K 科目详情
- /k/english/:theme K 英文 Theme 详情
- /virtue 美德课程（跨班型）
- /montessori 蒙特梭利资料（Pre-K 专属）
- /upload 资源上传（授权教师）
- /my-resources 我的资源
- /admin/teachers 教师管理（管理员）
- /admin/permissions 权限管理（管理员）
- /admin/audit 审计日志（管理员）
- /review 审核工作台（教学主任）

## 双语规范
- 中文模式下，除英文专业学科外，界面只显示中文
- 英文专业学科（English Language、Reading Comprehension 等）保留英文术语
- S1/S2 中文显示为"第一学期/第二学期"
- 资源"待补充"显示为"Not filled in source"（双语都保留）
