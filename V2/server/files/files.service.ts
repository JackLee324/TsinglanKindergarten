import { Inject, Injectable } from '@nestjs/common'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import { AuditService } from '../audit/audit.service'
import { AuthorizationService } from '../authz/authorization.service'
import {
  StorageService,
  isValidStorageKey,
  storageKeyBelongsTo,
} from '../storage/storage.service'
import { AppError } from '../common/http-error'
import type { AuthUser } from '../common/auth-user'
import {
  FILE_ERROR_CODES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_LABEL,
  PREVIEW_UNSUPPORTED_MESSAGE,
  classifyFile,
  type FileRejection,
  viewerFor,
} from '../../shared/file-policy'
import { toFileView } from './file-view'
import { EDITABLE_STATUSES, type ResourceStatus } from '../../shared/resource-status'

/**
 * FilesService —— 真实文件的四步链路
 * ============================================================================
 *   ① 申请上传地址（服务端校验 + 生成**带 sha256 的**签名地址 + 写下票据）
 *   → ② 浏览器直接 PUT 到对象存储（字节与声明哈希不一致会被**存储层**拒绝）
 *   → ③ 服务端确认对象真的存在、大小一致、内容类型合法
 *   → ④ 写 resource_files，票据作废
 *
 * 与阶段 2 版本的三个关键差别，每一条都对应一类真实故障：
 *
 *  1. **登记只认票据**（`uploadId`），不再接受客户端重复声明 size/sha256。
 *     否则"申请时声明 A、登记时声明 B"这个缺口就永远存在。
 *  2. **内容类型用 magic bytes 再判一次**。申请时看不到字节，只能靠扩展名 + MIME；
 *     登记时对象已经在存储里，把前 64 字节读回来验真 —— 这是业主 §5 的
 *     "扩展名 / MIME / magic bytes 三者综合判断"里唯一能挡住"改名换姓"的一步。
 *  3. **删除先删对象、再删数据库行**。反过来（先删行再删对象）在存储报错时
 *     会留下一个"数据库里没有、桶里有"的孤儿，而且**没人知道它存在**。
 *     先删对象则相反：存储失败就整个失败，数据库保持原样 —— 用户重试即可。
 */
@Injectable()
export class FilesService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
  ) {}

  /** 上传地址与票据的有效期（秒）—— 票据与地址必须同寿，否则会出现"地址还能用、票据已过期"。 */
  private get putTtlSeconds(): number {
    return this.storage.presignPutTtlSeconds
  }

  // ── ① 申请上传地址 ────────────────────────────────────────────────────────

  async createUploadUrl(
    actor: AuthUser,
    resourceId: string,
    input: { fileName: string; mimeType?: string; size: number; sha256: string },
  ) {
    const row = await this.requireResource(actor, resourceId)
    await this.assertCan(actor, 'resource.update.own', row, { requireOwner: true })
    this.assertFilesUnlocked(row.status)

    // 这一步只能校验"名字 / 扩展名 / 声明的 MIME / 大小" —— 字节还没上传，看不到内容。
    // 内容真伪在登记时用 magic bytes 判定（见 register）。
    const verdict = classifyFile({
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size,
    })
    if (!verdict.ok) throw fileRejection(verdict)

    const sha256 = input.sha256.toLowerCase()
    const storageKey = this.storage.newKey(resourceId, input.fileName)

    const ticket = await this.sql<{ id: string; expires_at: Date }[]>`
      INSERT INTO upload_tickets
        (resource_id, user_id, storage_key, file_name, mime_type, size, sha256, expires_at)
      VALUES
        (${resourceId}, ${actor.id}, ${storageKey}, ${input.fileName}, ${verdict.type.mime},
         ${input.size}, ${sha256},
         now() + make_interval(secs => ${this.putTtlSeconds}))
      RETURNING id::text, expires_at
    `

    // 预签名把 (size, sha256) 写进签名：浏览器拿到的地址**改不了**这两个值，
    // 存储层会在 PUT 时按它们校验。
    const presigned = await this.storage.presignPut(storageKey, {
      contentType: verdict.type.mime,
      size: input.size,
      sha256,
    })

    return {
      uploadId: ticket[0].id,
      storageKey: presigned.storageKey,
      uploadUrl: presigned.url,
      method: presigned.method,
      headers: presigned.headers,
      expiresInSeconds: presigned.expiresInSeconds,
      maxBytes: MAX_FILE_SIZE_BYTES,
      fileName: input.fileName,
      mimeType: verdict.type.mime,
    }
  }

  // ── ③+④ 确认对象并登记 ────────────────────────────────────────────────────

  async register(actor: AuthUser, resourceId: string, uploadId: string) {
    const row = await this.requireResource(actor, resourceId)
    await this.assertCan(actor, 'resource.update.own', row, { requireOwner: true })
    this.assertFilesUnlocked(row.status)

    const tickets = await this.sql<
      {
        id: string
        resource_id: string
        user_id: string
        storage_key: string
        file_name: string
        mime_type: string
        size: string
        sha256: string
        expires_at: Date
        consumed_at: Date | null
      }[]
    >`SELECT * FROM upload_tickets WHERE id = ${uploadId}`

    if (tickets.length === 0) {
      throw AppError.notFound('上传记录不存在，请重新上传', 'FILE_NOT_FOUND')
    }
    const ticket = tickets[0]

    // 票据必须属于这个资源、这个用户。否则 A 能拿 B 的票据把文件登记到别人名下。
    if (ticket.resource_id !== resourceId) {
      throw AppError.forbidden('这个上传记录不属于当前资源', 'FORBIDDEN')
    }
    if (ticket.user_id !== actor.id) {
      throw AppError.forbidden('这个上传记录不属于你', 'FORBIDDEN')
    }
    if (ticket.consumed_at !== null) {
      throw AppError.conflict('这个上传记录已经登记过了', 'CONFLICT')
    }
    if (ticket.expires_at.getTime() < Date.now()) {
      await this.recordOrphan(ticket.storage_key, resourceId, 'TICKET_EXPIRED')
      throw AppError.badRequest('上传地址已过期，请重新申请上传', 'UPLOAD_TICKET_EXPIRED')
    }
    if (!isValidStorageKey(ticket.storage_key) || !storageKeyBelongsTo(ticket.storage_key, resourceId)) {
      throw AppError.forbidden('上传地址不属于当前资源', 'FORBIDDEN')
    }

    // ③ 对象必须真的存在、大小一致、并且能被存储层确认内容哈希。
    const size = Number(ticket.size)
    const verification = await this.storage.verify(ticket.storage_key, {
      size,
      sha256: ticket.sha256,
    })
    if (!verification.ok) {
      await this.recordOrphan(
        ticket.storage_key,
        resourceId,
        verification.reason ?? 'VERIFY_FAILED',
        verification.detail ?? null,
      )
      if (verification.reason === 'NOT_FOUND') {
        throw AppError.badRequest(
          '对象存储里找不到刚上传的文件，请重新上传',
          'FILE_NOT_FOUND',
        )
      }
      if (verification.reason === 'SIZE_MISMATCH') {
        throw AppError.badRequest(
          `上传的文件大小与申请时不一致（${verification.detail ?? ''}）`,
          'FILE_SIZE_MISMATCH',
        )
      }
      throw AppError.badRequest(
        '上传的文件内容与申请时的 sha256 不一致（请重新上传）',
        'FILE_HASH_MISMATCH',
      )
    }

    // ③′ magic bytes 验真：把对象开头读回来，确认"内容确实是它自称的那个类型"。
    const head = await this.readObjectHead(ticket.storage_key)
    const contentVerdict = classifyFile({
      fileName: ticket.file_name,
      mimeType: ticket.mime_type,
      size,
      headBytes: head,
    })
    if (!contentVerdict.ok) {
      await this.recordOrphan(
        ticket.storage_key,
        resourceId,
        'CONTENT_TYPE_MISMATCH',
        contentVerdict.message,
      )
      throw fileRejection(contentVerdict)
    }

    // ④ 写库。票据的作废与文件行的写入在**一个事务**里完成 ——
    // 否则可能出现"文件登记成功但票据没作废"，于是同一张票据能登记两次。
    const inserted = await this.sql.begin(async (tx) => {
      const files = await tx<
        {
          id: string
          resource_id: string
          file_name: string
          mime_type: string
          size: string
          sha256: string
          created_at: Date
        }[]
      >`
        INSERT INTO resource_files
          (resource_id, file_name, storage_key, mime_type, size, sha256, created_by)
        VALUES
          (${resourceId}, ${ticket.file_name}, ${ticket.storage_key}, ${ticket.mime_type},
           ${size}, ${ticket.sha256}, ${actor.id})
        RETURNING id::text, resource_id, file_name, mime_type, size, sha256, created_at
      `
      await tx`
        UPDATE upload_tickets
        SET consumed_at = now(), consumed_file_id = ${files[0].id}
        WHERE id = ${ticket.id} AND consumed_at IS NULL
      `
      return files[0]
    })

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.create',
      targetType: 'file',
      targetId: inserted.id,
      result: 'success',
      detail: {
        resourceId,
        fileName: ticket.file_name,
        size,
        verified: true,
        verifiedBy: verification.method,
        // 有意不记录 storageKey / 签名 URL（见 audit 的 forbidden detail keys）。
      },
    })

    return toFileView(inserted)
  }

  // ── 读取 ──────────────────────────────────────────────────────────────────

  async list(actor: AuthUser, resourceId: string) {
    await this.requireResource(actor, resourceId)
    const rows = await this.sql<
      {
        id: string
        file_name: string
        mime_type: string
        size: string
        sha256: string
        created_at: Date
      }[]
    >`
      SELECT id::text, file_name, mime_type, size, sha256, created_at
      FROM resource_files WHERE resource_id = ${resourceId} ORDER BY created_at
    `
    return rows.map(toFileView)
  }

  /**
   * 预览。
   *
   * 白名单外**不是**返回一个坏掉的链接，而是返回可读的说明，
   * 让界面显示业主指定的那句话：「此文件类型暂不支持在线预览，请下载查看。」
   */
  async preview(actor: AuthUser, resourceId: string, fileId: string) {
    const { resource, file } = await this.requireFile(actor, resourceId, fileId)
    await this.assertCan(actor, 'resource.download', resource, { requireOwner: false })

    const viewer = viewerFor(file.file_name, file.mime_type)
    if (viewer === null) {
      return {
        previewable: false as const,
        mimeType: file.mime_type,
        fileName: file.file_name,
        viewer: null,
        message: PREVIEW_UNSUPPORTED_MESSAGE,
      }
    }

    const url = await this.presignRead(file, 'inline')
    return {
      previewable: true as const,
      url,
      mimeType: file.mime_type,
      fileName: file.file_name,
      viewer,
      expiresInSeconds: this.storage.presignTtlSeconds,
    }
  }

  /**
   * 下载：授权后生成**短期**签名地址。
   *
   * 界面只显示「下载」；bucket / storage key / 令牌都不会出现在响应里 ——
   * 前端拿到的是一个已经带权限的短命 URL，且 `Content-Disposition` 由服务端决定。
   */
  async download(actor: AuthUser, resourceId: string, fileId: string) {
    const { resource, file } = await this.requireFile(actor, resourceId, fileId)
    await this.assertCan(actor, 'resource.download', resource, { requireOwner: false })

    const url = await this.presignRead(file, 'attachment')
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
      url,
      fileName: file.file_name,
      mimeType: file.mime_type,
      size: Number(file.size),
      sha256: file.sha256,
      expiresInSeconds: this.storage.presignTtlSeconds,
    }
  }

  // ── 删除 ──────────────────────────────────────────────────────────────────

  async remove(actor: AuthUser, resourceId: string, fileId: string) {
    const { resource, file } = await this.requireFile(actor, resourceId, fileId)
    await this.assertCan(actor, 'resource.update.own', resource, { requireOwner: true })
    this.assertFilesUnlocked(resource.status)

    // ⚠️ 顺序不能反：**先删对象，再删数据库行**。
    // 反过来的话，存储删除失败时数据库已经删了 —— 桶里留下一个没人知道的孤儿，
    // 而且用户看到的界面是"删成功了"。先删对象则失败即整体失败，重试即可（§17）。
    await this.storage.delete(file.storage_key)
    await this.sql`DELETE FROM resource_files WHERE id = ${fileId}`

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.update',
      targetType: 'file',
      targetId: fileId,
      result: 'success',
      detail: { resourceId, removed: true, fileName: file.file_name },
    })
    return { ok: true, removedFileId: fileId }
  }

  // ── 内部工具 ──────────────────────────────────────────────────────────────

  /**
   * 已发布的资源不允许直接增删文件。
   *
   * 已发布的资源是老师们正在用的版本；直接换掉里面的文件等于**未经审核就改了线上内容**。
   * 生命周期规定了正确路径：撤回（PUBLISHED → RECALLED）→ 修改 → 重新提交审核。
   */
  private assertFilesUnlocked(status: string): void {
    if (EDITABLE_STATUSES.includes(status as ResourceStatus)) return
    throw AppError.conflict(
      status === 'PUBLISHED'
        ? '已发布的资源不能直接增删文件，请先「撤回」再修改'
        : '待审核的资源不能增删文件，请先等审核结果或撤回',
      'RESOURCE_LOCKED',
    )
  }

  /**
   * 只读取对象开头 64 字节：够判断所有 magic bytes，又不必把整个文件拉回来。
   *
   * 走门面而不是某个驱动：本地驱动直接切文件，S3 驱动发 `Range: bytes=0-63`。
   * 于是"登记时验内容类型"这件事**不需要把 50MB 课件拉回 VPS**。
   */
  private async readObjectHead(storageKey: string): Promise<Uint8Array> {
    const buf = await this.storage.readRange(storageKey, 64)
    return buf.subarray(0, 64)
  }

  private presignRead(
    file: { storage_key: string; file_name: string; mime_type: string },
    disposition: 'inline' | 'attachment',
  ): Promise<string> {
    return this.storage
      .presignGet(file.storage_key, {
        disposition,
        fileName: file.file_name,
        contentType: file.mime_type,
      })
      .then((r) => r.url)
  }

  /**
   * 记录孤儿对象（§29）。
   *
   * 不引入任务系统：只写一条 marker（key + 原因 + 细节），
   * 交给 `scripts/cleanup-orphans.mjs` 处理。
   * 幂等：同一个 key 在未清理前只会有一条待处理记录。
   */
  private async recordOrphan(
    storageKey: string,
    resourceId: string | null,
    reason: string,
    detail?: string | null,
  ): Promise<void> {
    try {
      await this.sql`
        INSERT INTO storage_orphans (storage_key, resource_id, reason, detail)
        VALUES (${storageKey}, ${resourceId}, ${reason},
                ${this.sql.json({ detail: detail ?? null })})
        ON CONFLICT (storage_key) WHERE cleaned_at IS NULL DO NOTHING
      `
    } catch {
      // 记 marker 失败不能把"登记失败"这件事本身盖掉 —— 用户还是要看到真实原因。
    }
  }

  /**
   * 取资源，并把"这个人能不能看见这条资源"一并判定掉。
   *
   * ⚠️ 这一步不能省。文件的所有入口（列表 / 下载 / 预览 / 上传 / 删除）都从这里过，
   * 少判一次就意味着：知道 id 的人可以列出、下载同事**未发布草稿**里的文件 ——
   * 列表页看不到它，文件接口却给得出来。这个洞是集成测试发现的。
   */
  private async requireResource(
    actor: AuthUser,
    resourceId: string,
  ): Promise<{
    id: string
    directory_id: string
    uploader_id: string | null
    status: string
  }> {
    const rows = await this.sql<
      { id: string; directory_id: string; uploader_id: string | null; status: string }[]
    >`
      SELECT id, directory_id, uploader_id, status FROM resources
      WHERE id = ${resourceId} AND deleted_at IS NULL
    `
    if (rows.length === 0) throw AppError.notFound('资源不存在')
    const row = rows[0]

    const visibility = await this.authz.canViewResource(actor, {
      status: row.status,
      uploaderId: row.uploader_id,
    })
    if (!visibility.allowed) {
      await this.audit.write({
        actorId: actor.id,
        actorName: actor.name,
        action: 'authz.denied',
        targetType: 'resource',
        targetId: row.id,
        result: 'denied',
        detail: { permission: 'resource.view', reason: visibility.reason, status: row.status },
      })
      throw AppError.forbidden('这条资源还没有发布，只有上传者本人能看到', 'FORBIDDEN')
    }
    return row
  }

  private async requireFile(actor: AuthUser, resourceId: string, fileId: string) {
    const resource = await this.requireResource(actor, resourceId)
    const rows = await this.sql<
      {
        id: string
        file_name: string
        storage_key: string
        mime_type: string
        size: string
        sha256: string
        created_at: Date
      }[]
    >`
      SELECT id::text, file_name, storage_key, mime_type, size, sha256, created_at
      FROM resource_files
      WHERE id = ${fileId} AND resource_id = ${resourceId}
    `
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
    resource: { id: string; directory_id: string; uploader_id: string | null },
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

/** 把文件策略的判定结果翻译成一个带 code 的 HTTP 错误。 */
function fileRejection(rejection: FileRejection) {
  // 超限的文案带上上限本身：老师说"太大"而不知道多大才算合适，等于没说。
  const message =
    rejection.code === FILE_ERROR_CODES.FILE_TOO_LARGE
      ? `${rejection.message}（上限 ${MAX_FILE_SIZE_LABEL}）`
      : rejection.message
  return rejection.status === 413
    ? AppError.tooLarge(message, rejection.code)
    : AppError.badRequest(message, rejection.code)
}

