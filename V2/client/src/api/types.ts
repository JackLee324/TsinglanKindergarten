/**
 * client/src/api/types.ts —— 前端使用的接口形状。
 *
 * 与后端 `shared/api.ts` 是同一套概念。**没有第二份定义**：
 * 能直接引用 shared 的地方就引用，这里只放前端特有的展示型类型。
 */
import type { PermissionCode, UserRole } from '@shared/permissions'

export type { PermissionCode, UserRole }

export interface SessionUser {
  readonly id: string
  readonly username: string
  readonly name: string
  readonly nameEn: string | null
  readonly role: UserRole
}

export interface Capabilities {
  readonly role: UserRole
  readonly permissions: readonly string[]
  readonly canManageDirectories: boolean
  readonly canManageUsers: boolean
  readonly canReview: boolean
  readonly canPublish: boolean
  readonly canViewAudit: boolean
  readonly canUpload: boolean
}

/** 服务端算好的能力位。**前端不得自行推断**（否则按钮显隐与接口判定会分叉）。 */
export interface NodeCapabilities {
  readonly canManage: boolean
  readonly canCreateChild: boolean
  readonly canUpload: boolean
  readonly canCreateFolder: boolean
}

export interface DirectoryNode {
  readonly id: string
  readonly parentId: string | null
  readonly slug: string
  readonly name: string
  readonly nameEn: string | null
  readonly description: string | null
  readonly type: 'ROOT' | 'CATEGORY' | 'SECTION' | 'FOLDER'
  readonly sortOrder: number
  readonly enabled: boolean
  readonly allowChildren: boolean
  readonly allowFiles: boolean
  readonly allowCustomFolders: boolean
  readonly icon: string | null
  readonly path: string
  readonly capabilities: NodeCapabilities
  readonly resourceCount: number
  readonly children: readonly DirectoryNode[]
}

export interface DirectoryNodeDetail extends Omit<DirectoryNode, 'children'> {
  readonly children: readonly DirectoryNode[]
  readonly ancestors: readonly DirectoryNode[]
}
