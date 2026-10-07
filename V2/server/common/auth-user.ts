import type { PermissionCode, UserRole } from '../../shared/permissions'

/** 请求上下文里的当前用户。**不含**任何凭据字段（身份来自会话表）。 */
export interface AuthUser {
  readonly id: string
  readonly username: string
  readonly name: string
  readonly nameEn: string | null
  readonly role: UserRole
}

/** 一次授权判定的结果，用于审计被拒绝的请求。 */
export interface AuthorizationDecision {
  readonly allowed: boolean
  readonly reason:
    | 'admin'
    | 'global-grant'
    | 'directory-grant'
    | 'no-grant'
    | 'out-of-scope'
    | 'not-owner'
    | 'target-missing'
  readonly permission: PermissionCode
  readonly directoryId: string | null
}
