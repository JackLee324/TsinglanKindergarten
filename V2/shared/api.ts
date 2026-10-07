/**
 * shared/api.ts —— 前后端共享的请求/响应形状。
 *
 * 阶段 2 只建后端，但类型现在就要定下来：前端阶段直接引用这些类型，
 * 避免"接口改了前端不知道"（V1 的已知缺陷：API 与前端类型不一致）。
 */

import type { PermissionCode, UserRole } from './permissions'
import type { DirectoryNode, DirectoryTreeNode } from './directory'
import type { ResourceStatus } from './resource-status'

export interface ApiError {
  readonly statusCode: number
  readonly code: string
  readonly message: string
}

export interface Page<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

export interface SessionUser {
  readonly id: string
  readonly username: string
  readonly name: string
  readonly nameEn: string | null
  readonly role: UserRole
  /** 该用户真实持有的权限码（管理员界面用不到，接口自我说明用不到）。 */
  readonly permissions: readonly PermissionCode[]
}

export interface DirectoryTreeResponse {
  readonly roots: readonly DirectoryTreeNode[]
}

export interface ResourceSummary {
  readonly id: string
  readonly directoryId: string
  readonly title: string
  readonly titleEn: string | null
  readonly description: string | null
  readonly status: ResourceStatus
  readonly version: number
  readonly uploaderId: string | null
  readonly uploaderName: string | null
  readonly fileCount: number
  readonly hasFile: boolean
  readonly publishedAt: string | null
  readonly deletedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ResourceDetail extends ResourceSummary {
  /** 完整目录路径（由 parentId 链推出），例如 教育教学 / Pre-K / 美德 / 教学资源。 */
  readonly directoryPath: string
  readonly files: readonly ResourceFile[]
  readonly reviewComment: string | null
}

export interface ResourceFile {
  readonly id: string
  readonly fileName: string
  readonly mimeType: string
  readonly size: number
  readonly sha256: string
  readonly previewable: boolean
  readonly createdAt: string
}

export interface UserPermissionGrant {
  readonly permission: PermissionCode
  readonly directoryId: string | null
}

export interface ErrorCode {
  readonly ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION'
  readonly NOT_FOUND: 'NOT_FOUND'
  readonly FORBIDDEN: 'FORBIDDEN'
  readonly UNAUTHENTICATED: 'UNAUTHENTICATED'
  readonly VALIDATION_FAILED: 'VALIDATION_FAILED'
  readonly CONFLICT: 'CONFLICT'
  readonly PREVIEW_UNSUPPORTED: 'PREVIEW_UNSUPPORTED'
  readonly DIRECTORY_HAS_CHILDREN: 'DIRECTORY_HAS_CHILDREN'
  readonly DIRECTORY_HAS_RESOURCES: 'DIRECTORY_HAS_RESOURCES'
  readonly FILE_MISSING: 'FILE_MISSING'
}

export type { DirectoryNode, DirectoryTreeNode, PermissionCode, ResourceStatus, UserRole }
