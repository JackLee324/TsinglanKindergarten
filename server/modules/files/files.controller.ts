import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Logger,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { CurrentTeacher } from '@server/modules/auth/auth.guard';
import { RequirePermission } from '@server/modules/authz/permission.decorator';
import { ResourcesService } from '@server/modules/resources/resources.service';
import { AuditLoggerService } from '@server/modules/audit/audit-logger.service';
import { getClientIp } from '@server/common/http/client-ip';
import {
  verifyDownloadToken,
  downloadTokenConfigurationError,
  downloadTokenTtlSeconds,
  DOWNLOAD_TOKEN_SECRET_ENV,
} from '@server/common/crypto/download-token';
import { FilesService } from './files.service';
import type { AuthUser } from '@shared/api.interface';

/**
 * `GET /api/files/download?token=…` — the ONLY endpoint that turns a download
 * token into bytes.
 *
 * WHY A SECOND STEP EXISTS AT ALL
 * -------------------------------
 * `GET /api/resources/:id/download` mints a token and redirects here. Splitting
 * the two makes the capability explicit and checkable at the moment it is used:
 *
 *   (a) the token is verified (signature + expiry),
 *   (b) a REAL session is required — the global AuthGuard rejects an
 *       unauthenticated request before this handler runs,
 *   (c) the session's teacher id must EQUAL the token's, so a URL leaked from one
 *       account is useless to any other (including to an administrator: the token
 *       names its owner, and being an admin does not make you that owner),
 *   (d) the resource is re-loaded and the download permission AND the subject
 *       permission are re-checked — authority can be revoked between minting the
 *       link and using it, and a link must not outlive the permission that
 *       justified it,
 *   (e) the attempt is audited: success and every distinct failure reason,
 *   (f) only then is the object-storage backend asked for a signed URL and the
 *       browser redirected to it.
 *
 * WHY THE FINAL STEP CANNOT SILENTLY SUCCEED ANYWHERE
 * ---------------------------------------------------
 * This deployment has no object-storage backend configured (see files.service.ts
 * and object-storage.ts), so (f) answers 503 STORAGE_NOT_CONFIGURED. There is no
 * code path that returns a placeholder URL, an empty body or a fabricated link:
 * an unroutable download must look broken, not work-looking.
 *
 * KNOWN LIMITATION, STATED RATHER THAN HIDDEN
 * -------------------------------------------
 * The redirect hands the browser to the object store, so the response headers of
 * the actual file are chosen by the storage backend, not by us — `Content-Disposition:
 * attachment` cannot be enforced on a cross-origin redirect. The compensating
 * controls are on the WRITE side: HTML/SVG are refused by the upload validator
 * (stored XSS needs a file that the browser will execute, and none of the allowed
 * types is active) and the token is bound to one account and short-lived.
 * Streaming through the server instead would allow an explicit
 * `Content-Disposition: attachment`, and is the reason to prefer a server-side
 * upload path when the platform integration becomes available.
 */
@Controller('api/files')
export class FilesController {
  private readonly logger = new Logger(FilesController.name);

  constructor(
    private readonly filesService: FilesService,
    private readonly resourcesService: ResourcesService,
    private readonly auditLogger: AuditLoggerService,
  ) {}

  private getIp(req: Request): string | undefined {
    return getClientIp(req) || undefined;
  }

  @Get('download')
  // Both permissions, ANDed: `resource.download` is the curriculum capability and
  // `storage.download` is the storage capability. Every role that can download a
  // resource already holds both, so this narrows nothing for legitimate callers
  // and refuses a future grant that only half-authorises a download.
  @RequirePermission('resource.download', 'storage.download')
  async download(
    @Query('token') token: string | undefined,
    @CurrentTeacher() teacher: AuthUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ip = this.getIp(req);
    const sessionTeacherId = teacher?.id;

    // ---------------------------------------------------------------------
    // (0) deployment precondition. A missing signing key is an operator error,
    //     not a client error, and it must not be reported as a bad token.
    // ---------------------------------------------------------------------
    const configError = downloadTokenConfigurationError();
    if (configError) {
      this.logger.error(`download refused: ${configError}`);
      throw new ServiceUnavailableException(
        `下载链接签名密钥不可用（${DOWNLOAD_TOKEN_SECRET_ENV}），服务端无法校验下载链接。`,
      );
    }

    // ---------------------------------------------------------------------
    // (a) token verification
    // ---------------------------------------------------------------------
    const verification = verifyDownloadToken(typeof token === 'string' ? token : '');
    if (verification.ok === false) {
      await this.auditDenied({
        teacherId: sessionTeacherId,
        teacherName: teacher?.name,
        ip,
        errorMessage: `下载令牌无效：${verification.reason}`,
        detail: `token 校验失败 reason=${verification.reason}`,
      });

      if (verification.reason === 'malformed') {
        throw new BadRequestException('下载链接格式不正确');
      }
      if (verification.reason === 'expired') {
        throw new ForbiddenException('下载链接已过期，请重新获取');
      }
      throw new ForbiddenException('下载链接签名校验失败');
    }

    const payload = verification.payload;

    // ---------------------------------------------------------------------
    // (c) caller binding. Checked BEFORE anything about the resource is loaded,
    //     so a cross-account replay learns nothing about the target resource.
    // ---------------------------------------------------------------------
    if (!sessionTeacherId || sessionTeacherId !== payload.teacherId) {
      await this.auditDenied({
        teacherId: sessionTeacherId,
        teacherName: teacher?.name,
        resourceId: payload.resourceId,
        ip,
        errorMessage: '下载令牌与当前登录账号不一致',
        detail: `token.teacherId=${payload.teacherId} session.teacherId=${sessionTeacherId ?? '(none)'}`,
      });
      throw new ForbiddenException(
        '该下载链接属于其他账号，无法使用。请从你自己的账号重新获取下载链接。',
      );
    }

    // ---------------------------------------------------------------------
    // (d) re-authorise against the CURRENT state of the resource. Throws 404/403
    //     (and audits the denial) for a deleted, unpublished, out-of-scope or
    //     file-less resource.
    // ---------------------------------------------------------------------
    const target = await this.resourcesService.authorizeDownload(
      payload.resourceId,
      sessionTeacherId,
      ip,
    );

    // ---------------------------------------------------------------------
    // (e)/(f) resolve storage, then redirect or fail loudly.
    // ---------------------------------------------------------------------
    let signedUrl: string;
    try {
      signedUrl = await this.filesService.createSignedStorageUrl(
        target.fileBucketId,
        target.filePath,
        downloadTokenTtlSeconds(),
      );
    } catch (error) {
      await this.auditFailure({
        teacherId: sessionTeacherId,
        teacherName: teacher?.name,
        resourceId: target.id,
        resourceTitle: target.title,
        program: target.program,
        subject: target.subject,
        ip,
        errorMessage: (error as Error)?.message ?? '存储后端不可用',
        detail: '平台对象存储不可用，未向客户端返回任何地址',
      });
      throw error;
    }

    await this.auditLogger.log('resource_download', {
      teacherId: sessionTeacherId,
      teacherName: teacher?.name,
      resourceId: target.id,
      resourceTitle: target.title,
      program: target.program,
      subject: target.subject,
      success: true,
      ipAddress: ip,
      detail: `令牌校验通过，已 302 重定向至对象存储直链（bucket=${target.fileBucketId}）`,
    });

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(target.fileName)}"`,
    );
    res.redirect(HttpStatus.FOUND, signedUrl);
  }

  /** Denials that happen before a resource is known. */
  private async auditDenied(params: {
    teacherId?: string;
    teacherName?: string;
    resourceId?: string;
    ip?: string;
    errorMessage: string;
    detail: string;
  }): Promise<void> {
    await this.auditLogger.log('resource_download_denied', {
      teacherId: params.teacherId,
      teacherName: params.teacherName,
      resourceId: params.resourceId,
      success: false,
      ipAddress: params.ip,
      errorMessage: params.errorMessage,
      detail: params.detail,
    });
  }

  /** A failure of the storage backend itself (distinct from a denial). */
  private async auditFailure(params: {
    teacherId?: string;
    teacherName?: string;
    resourceId?: string;
    resourceTitle?: string;
    program?: string;
    subject?: string;
    ip?: string;
    errorMessage: string;
    detail: string;
  }): Promise<void> {
    await this.auditLogger.log('resource_download_failed', {
      teacherId: params.teacherId,
      teacherName: params.teacherName,
      resourceId: params.resourceId,
      resourceTitle: params.resourceTitle,
      program: params.program,
      subject: params.subject,
      success: false,
      ipAddress: params.ip,
      errorMessage: params.errorMessage,
      detail: params.detail,
    });
  }
}
