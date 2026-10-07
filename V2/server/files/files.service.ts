import { Inject, Injectable } from '@nestjs/common'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import { AuditService } from '../audit/audit.service'
import { AuthorizationService } from '../authz/authorization.service'
import { StorageService, isValidStorageKey } from '../storage/storage.service'
import { AppError } from '../common/http-error'
import type { AuthUser } from '../common/auth-user'
import { isPreviewable, PREVIEW_UNSUPPORTED_MESSAGE } from '../../shared/resource-status'

/** 上传大小上限：50 MB。 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

interface FileRow {
  id: string
  resource_id: string
  file_name: string
  storage_key: string
  mime_type: string
  size: string
  sha256: string
  created_at: Date
}

interface ResourceGateRow {
  id: string
  directory_id: string
  uploader_id: string | null
}

/**
 * FilesService —— 真实文件的四步链路
 * ============================================================================
 *   ① 申请上传地址 → ② 浏览器 PUT → ③ 服务端**读回对象校验** → ④ 登记 resource_files
 *
 * 第 ③ 步是这套设计的关键，也是 V1 吃过亏的地方：V1 出现过"数据库说有文件、
 * 对象存储里却没有"的行，于是资源列表里有几百条点了下载必然失败的记录。
 * V2 把校验放在登记**之前**：校验不过就拒绝登记。
 *
 * 没有 placeholder、没有 fake bucket、没有假 URL：登记时真的把对象读出来
 * 算 sha256，与客户端声明的值比对。
 *
 * 文件的可见性**完全复用资源所在目录的授权判定**，不新建第二套口径。
 */
@Injectable()
export class FilesService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
  ) {}

  /** ① 申请上传地址。 */
  async createUploadUrl(
    actor: AuthUser,
    resourceId: string,
    input: { fileName: string; mimeType: string; size: number },
  ) {
    const row = await this.requireResource(resourceId)
    await this.assertCan(actor, 'resource.update.own', row, { requireOwner: true })

    if (input.size > MAX_FILE_BYTES) {
      throw AppError.conflict(
        `文件超过 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB 上限`,
        'VALIDATION_FAILED',
      )
    }
    const storageKey = this.storage.newKey(row.directory_id, resourceId, input.fileName)
    const presigned = this.storage.presignPut(storageKey)
    return {
      storageKey: presigned.storageKey,
      uploadUrl: presigned.url,
      method: presigned.method,
      headers: presigned.headers,
      maxBytes: MAX_FILE_BYTES,
    }
  }

  /**
   * ③+④ 校验并登记。四项校验全部通过才写库：
   * 对象**存在**、key 属于本资源、大小一致、sha256 一致。
   */
  async register(
    actor: AuthUser,
    resourceId: string,
    input: {
      storageKey: string
      fileName: string
      mimeType: string
      size: number
      sha256: string
    },
  ) {
    const row = await this.requireResource(resourceId)
    await this.assertCan(actor, 'resource.update.own', row, { requireOwner: true })

    if (!isValidStorageKey(input.storageKey)) {
      throw AppError.forbidden('存储 key 不合法', 'VALIDATION_FAILED')
    }
    // key 必须以本资源为前缀 —— 否则 A 资源可以把 B 刚上传的对象登记到自己名下。
    if (!input.storageKey.startsWith(`${row.directory_id}/${resourceId}/`)) {
      throw AppError.forbidden('这个上传地址不属于当前资源', 'FORBIDDEN')
    }

    const head = this.storage.head(input.storageKey)
    if (head === null) {
      throw AppError.conflict(
        '对象存储里找不到刚上传的文件，登记已取消（请重新上传）',
        'FILE_MISSING',
      )
    }
    if (head.size !== input.size) {
      throw AppError.conflict(
        `文件大小与登记值不一致（实际 ${head.size}，声明 ${input.size}）`,
        'VALIDATION_FAILED',
      )
    }
    if (head.sha256 !== input.sha256.toLowerCase()) {
      throw AppError.conflict('文件内容校验失败（sha256 不一致）', 'VALIDATION_FAILED')
    }

    const duplicate = await this.sql<{ id: string }[]>`
      SELECT id FROM resource_files WHERE storage_key = ${input.storageKey}
    `
    if (duplicate.length > 0) {
      throw AppError.conflict('这个文件已经登记过了', 'CONFLICT')
    }

    const inserted = await this.sql<FileRow[]>`
      INSERT INTO resource_files
        (resource_id, file_name, storage_key, mime_type, size, sha256, created_by)
      VALUES
        (${resourceId}, ${input.fileName}, ${input.storageKey}, ${input.mimeType},
         ${input.size}, ${input.sha256.toLowerCase()}, ${actor.id})
      RETURNING *
    `

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.create',
      targetType: 'file',
      targetId: inserted[0].id,
      result: 'success',
      detail: {
        resourceId,
        fileName: input.fileName,
        size: input.size,
        verified: true,
        // 有意不记录 storageKey / 签名 URL（见 AUDIT_FORBIDDEN_DETAIL_KEYS）
      },
    })

    return toFileView(inserted[0])
  }

  async list(resourceId: string): Promise<ReturnType<typeof toFileView>[]> {
    const rows = await this.sql<FileRow[]>`
      SELECT * FROM resource_files WHERE resource_id = ${resourceId} ORDER BY created_at
    `
    return rows.map(toFileView)
  }

  /** 下载：真实字节；签名 URL 只在服务端出现，前端看不到 bucket/key。 */
  async download(actor: AuthUser, resourceId: string, fileId: string) {
    const { resource, file } = await this.requireFile(resourceId, fileId)
    await this.assertCan(actor, 'resource.download', resource, { requireOwner: false })

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.download',
      targetType: 'file',
      targetId: fileId,
      result: 'success',
      detail: { resourceId, fileName: file.file_name, size: Number(file.size) },
    })
    return {
      url: this.storage.presignGet(file.storage_key, 'attachment', file.file_name),
      fileName: file.file_name,
      size: Number(file.size),
    }
  }

  /**
   * 预览。
   *
   * 白名单外**不是**返回一个坏掉的链接，而是返回可读的说明，
   * 让界面显示业主指定的那句话：「此文件类型暂不支持在线预览，请下载查看。」
   */
  async preview(actor: AuthUser, resourceId: string, fileId: string) {
    const { resource, file } = await this.requireFile(resourceId, fileId)
    await this.assertCan(actor, 'resource.download', resource, { requireOwner: false })

    if (!isPreviewable(file.mime_type)) {
      return {
        previewable: false as const,
        mimeType: file.mime_type,
        message: PREVIEW_UNSUPPORTED_MESSAGE,
      }
    }
    return {
      previewable: true as const,
      url: this.storage.presignGet(file.storage_key, 'inline', file.file_name),
      mimeType: file.mime_type,
    }
  }

  async remove(actor: AuthUser, resourceId: string, fileId: string) {
    const { resource, file } = await this.requireFile(resourceId, fileId)
    await this.assertCan(actor, 'resource.update.own', resource, { requireOwner: true })

    await this.sql`DELETE FROM resource_files WHERE id = ${fileId}`
    this.storage.delete(file.storage_key)

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.update',
      targetType: 'file',
      targetId: fileId,
      result: 'success',
      detail: { resourceId, removed: true, fileName: file.file_name },
    })
    return { ok: true }
  }

  private async requireResource(resourceId: string): Promise<ResourceGateRow> {
    const rows = await this.sql<ResourceGateRow[]>`
      SELECT id, directory_id, uploader_id FROM resources
      WHERE id = ${resourceId} AND deleted_at IS NULL
    `
    if (rows.length === 0) throw AppError.notFound('资源不存在')
    return rows[0]
  }

  private async requireFile(resourceId: string, fileId: string) {
    const rows = await this.sql<FileRow[]>`
      SELECT f.* FROM resource_files f
      JOIN resources r ON r.id = f.resource_id
      WHERE f.id = ${fileId} AND f.resource_id = ${resourceId} AND r.deleted_at IS NULL
    `
    const resource = await this.requireResource(resourceId)
    if (rows.length === 0) throw AppError.notFound('文件不存在')
    return { resource, file: rows[0] }
  }

  /**
   * 唯一授权入口：**转发**到 AuthorizationService。
   *
   * 这里**不再**出现 `uploader_id !== actor.id` 或 `role === 'ADMIN'` ——
   * 所有权、目录范围、管理员绕过都在统一授权里判定。
   * 文件与资源必须共用同一套判定，否则会出现"看得到资源却下不了文件"这类分叉。
   */
  private async assertCan(
    actor: AuthUser,
    permission: 'resource.download' | 'resource.update.own',
    resource: ResourceGateRow,
    options: { requireOwner: boolean },
  ): Promise<void> {
    const decision = await this.authz.canActOnResource(
      actor,
      permission,
      {
        id: resource.id,
        directoryId: resource.directory_id,
        uploaderId: resource.uploader_id,
      },
      { requireOwner: options.requireOwner },
    )
    if (decision.allowed) return

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'authz.denied',
      targetType: 'file',
      targetId: resource.id,
      result: 'denied',
      detail: { permission, reason: decision.reason, directoryId: resource.directory_id },
    })
    throw AppError.forbidden(
      decision.reason === 'not-owner' ? '只能操作自己上传的资源里的文件' : '没有权限访问这个文件',
      'FORBIDDEN',
    )
  }
}

function toFileView(row: FileRow) {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: Number(row.size),
    sha256: row.sha256,
    previewable: isPreviewable(row.mime_type),
    createdAt: row.created_at.toISOString(),
  }
}
