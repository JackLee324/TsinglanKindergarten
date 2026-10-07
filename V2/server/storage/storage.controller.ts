import { Controller, Get, Put, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { Public } from '../common/decorators'
import { StorageService } from './storage.service'
import { AppError } from '../common/http-error'

/**
 * local 存储驱动的**数据面**。
 *
 * 这两个端点是 `@Public()` 的 —— 因为浏览器上传/下载时拿的是**签名 URL**，
 * 不走会话 cookie（与 S3/R2 的行为一致）。
 * 安全完全由 URL 上的 HMAC 令牌保证：令牌含 op / key / 过期时间，
 * 且用 `timingSafeEqual` 比对。
 *
 * 换成 S3 驱动后这两个端点会被删掉（浏览器直连对象存储），
 * 但调用方（files 模块）与测试的形状不变。
 */
@Controller('api/storage/local')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Put()
  async put(
    @Query('key') key: string,
    @Query('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const storageKey = key ?? ''
    if (!this.storage.verifyPutToken(storageKey, token ?? '')) {
      throw AppError.forbidden('上传地址已过期或签名无效，请重新申请', 'FORBIDDEN')
    }
    const body = (req as Request & { body?: Buffer }).body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw AppError.conflict('上传内容为空', 'VALIDATION_FAILED')
    }
    const contentType = req.get('content-type') ?? 'application/octet-stream'
    this.storage.write(storageKey, body, contentType)
    res.status(200)
    return { ok: true, size: body.length }
  }

  @Public()
  @Get()
  async get(
    @Query('key') key: string,
    @Query('token') token: string,
    @Query('disposition') disposition: string | undefined,
    @Query('name') name: string | undefined,
    @Res() res: Response,
  ) {
    const storageKey = key ?? ''
    if (!this.storage.verifyGetToken(storageKey, token ?? '')) {
      throw AppError.forbidden('下载地址已过期或签名无效', 'FORBIDDEN')
    }
    const head = this.storage.head(storageKey)
    if (head === null) {
      throw AppError.notFound('文件不存在', 'FILE_MISSING')
    }
    const buf = this.storage.read(storageKey)
    res.setHeader('Content-Type', head.contentType)
    res.setHeader('Content-Length', String(buf.byteLength))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (disposition === 'attachment') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(name ?? 'download')}`,
      )
    } else {
      res.setHeader('Content-Disposition', 'inline')
    }
    res.end(buf)
  }
}
