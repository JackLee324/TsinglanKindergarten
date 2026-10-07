/**
 * shared/audit-actions.ts —— 审计动作（业主给定的清单，逐条对应）
 * ============================================================================
 * 只记有用的。**不记录**：密码、password_hash、session token、对象存储密钥、
 * 签名 URL、storage key。
 *
 * 与 V1 的差别：V1 的动作联合类型与界面标签必须**手工同步**，
 * 结果新增一个动作时忘了加标签，客户端类型检查直接红。
 * V2 把两者放在同一个对象里，标签从同一处生成，结构上不可能不同步。
 */

export const AUDIT_ACTIONS = {
  'auth.login': '登录',
  'auth.logout': '退出登录',
  'auth.change_password': '修改密码',

  'user.create': '账号创建',
  'user.update': '账号修改',
  'user.disable': '账号停用',
  // 管理员替别人设置新口令。**与用户自己改口令（auth.change_password）分开记**：
  // "是谁改的"在两种情况下答案完全不同，合并了就没法追。
  'user.password_change': '管理员重置密码',
  'user.permissions.update': '权限修改',

  'directory.create': '目录新增',
  'directory.update': '目录修改',
  'directory.reorder': '目录排序',
  'directory.move': '目录移动',
  'directory.delete': '目录删除',
  // 启停单独记：它们改变的是"老师还能不能看到这一块"，
  // 混在 directory.update 里会让"谁把某个目录关掉了"查不出来。
  'directory.enable': '目录启用',
  'directory.disable': '目录停用',

  'resource.create': '资源上传',
  'resource.update': '资源编辑',
  // 业主 Stage 7 §20 点名的四个动作，名字与规格逐字一致。
  'resource.submit_review': '提交审核',
  'resource.approve': '审核通过并发布',
  'resource.reject': '审核退回',
  'resource.recall': '资源撤回',
  'resource.delete': '资源删除',
  'resource.restore': '资源恢复',
  'resource.purge': '永久删除',
  'resource.download': '资源下载',

  // ── 内部：被拒绝的请求（业主口径里的"拒绝"也要留痕）─────────────────────
  'authz.denied': '权限不足被拒绝',
  // 路由漏声明权限（配置错误）。它不是用户错误，但必须可见 —— 否则
  // "fail closed" 只会表现为某个接口莫名 403，而没人知道原因。
  'authz.missing-declaration': '接口未声明权限',
} as const

export type AuditAction = keyof typeof AUDIT_ACTIONS

export const AUDIT_RESULTS = ['success', 'denied', 'failed'] as const
export type AuditResult = (typeof AUDIT_RESULTS)[number]

export function auditLabel(action: AuditAction): string {
  return AUDIT_ACTIONS[action]
}

/** 这些 key 绝不允许出现在审计 detail 里（用例会断言）。 */
export const AUDIT_FORBIDDEN_DETAIL_KEYS: readonly string[] = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'sessionToken',
  'tokenHash',
  'secret',
  'storageKey',
  'signedUrl',
  'downloadUrl',
  'csrfToken',
]
