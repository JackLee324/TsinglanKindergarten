import { Controller, Get, Put, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { Public } from '../common/decorators'
import { LocalStorageProvider } from './local.provider'
import { AppError } from '../common/http-error'

/**
 * local 存储驱动的**数据面**。
 *
 * 这两个端点是 `@Public()` 的 —— 因为浏览器上传/下载时拿的是**签名 URL**，
 * 不走会话 cookie（与 S3/R2 的行为一致）。
 * 安全完全由 URL 上的 HMAC 令牌保证：令牌含 op / key / 过期时间 /
 * **期望大小 / 期望 sha256**，且用 `timingSafeEqual` 比对。
 *
 * ⚠️ 上传这一步**会重算 sha256 并比对**，不一致就 400 且**不写入任何字节**。
 *
 * 为什么一定要这样：S3 驱动把 sha256 放进已签名的 `x-amz-checksum-sha256` 头，
 * 对象存储自己会拒绝不一致的字节。如果本地驱动只是"把收到的字节写进去"，
 * 那么两种驱动的**保证强度就不一样** —— 本地开发环境反而测不出完整性问题，
 * 而阶段 6 所有关于"上传的字节与声明的哈希必须一致"的断言在本地都会变成空话。
 * 所以这里让本地驱动承担同样的责任：一致性在**存储层**强制，而不是事后补检。
 */
@Controller('api/storage/local')
export class StorageController {
  constructor(private readonly local: LocalStorageProvider) {}

  @Public()
  @Put()
  async put(
    @Query('key') key: string,
    @Query('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const storageKey = key ?? ''
    const claimed = this.local.verifyPutToken(storageKey, token ?? '')
    if (claimed === null) {
      throw AppError.forbidden('上传地址已过期或签名无效，请重新申请', 'FORBIDDEN')
    }

    const body = (req as Request & { body?: Buffer }).body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw AppError.badRequest('上传内容为空', 'VALIDATION_FAILED')
    }

    // 大小：先看声明，再看实际 —— 两者都必须与令牌一致。
    if (body.length !== claimed.size) {
      throw AppError.badRequest(
        `上传的字节数与申请时声明的不一致（实际 ${body.length}，声明 ${claimed.size}）`,
        'FILE_SIZE_MISMATCH',
      )
    }
    const digest = createHash('sha256').update(body).digest()
    const expected = Buffer.from(claimed.sha256, 'hex')
    if (digest.length !== expected.length || !timingSafeEqual(digest, expected)) {
      // 与 S3 的 BadDigest 同一语义：内容与声明的哈希不符，拒绝落盘。
      throw AppError.badRequest(
        '上传内容与声明的 sha256 不一致，已拒绝写入（请重新上传）',
        'FILE_HASH_MISMATCH',
      )
    }

    const contentType = req.get('content-type') ?? 'application/octet-stream'
    this.local.write(storageKey, body, contentType)
    res.status(200)
    return { ok: true, size: body.length, sha256: claimed.sha256 }
  }

  /**
   * 下载 / 预览的数据面。
   *
   * ⚠️ 只认 URL 上的 `key` 与 `token`。`disposition` / 文件名 / `Content-Type`
   * **一律从令牌里取**（它们参与 HMAC），查询参数里就算带了也完全不用 ——
   * 否则一个签名地址可以被追加 `&type=text/html` 改掉响应类型、
   * 或者用 `&name=evil.exe` 改掉下载文件名。
   */
  @Public()
  @Get()
  async get(
    @Query('key') key: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    const storageKey = key ?? ''
    const claim = this.local.verifyGetToken(storageKey, token ?? '')
    if (claim === null) {
      throw AppError.forbidden('下载地址已过期或签名无效', 'FORBIDDEN')
    }
    const head = await this.local.head(storageKey)
    if (head === null) {
      throw AppError.notFound('文件已不存在，请联系管理员。', 'FILE_NOT_FOUND')
    }
    const buf = await this.local.read(storageKey)

    // §36：类型由**服务端**决定（令牌里的值来自数据库里的 mime），
    // 并且永远带 nosniff —— 于是"上传 HTML 再骗过预览执行脚本"这条路是堵死的。
    res.setHeader('Content-Type', claim.contentType)
    res.setHeader('Content-Length', String(buf.byteLength))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // §38：私有资源不允许被浏览器长期缓存。
    res.setHeader('Cache-Control', 'private, no-store, max-age=0')
    res.setHeader(
      'Content-Disposition',
      claim.disposition === 'attachment' ? attachmentHeader(claim.fileName) : 'inline',
    )
    res.end(buf)
  }
}

/** 与 S3 驱动保持同一形状：ASCII 兜底 + RFC 5987 的 UTF-8 文件名。 */
function attachmentHeader(fileName: string): string {
  const sanitized = fileName.replace(/["\\\r\n]/g, '_')
  const asciiFallback = sanitized.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(sanitized)}`
}
