import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common'
import { FilesService } from './files.service'
import { RegisterFileDto, UploadUrlDto } from '../resources/resources.dto'
import { CurrentUser, DirectoryScope, RequirePermission } from '../common/decorators'
import type { AuthUser } from '../common/auth-user'
import {
  ALLOWED_FILE_TYPES,
  ALLOWED_TYPES_LABEL,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_LABEL,
  PREVIEW_UNSUPPORTED_MESSAGE,
} from '../../shared/file-policy'

/** 给接口用的策略摘要（就是 shared/file-policy.ts 里那一份，没有第二份定义）。 */
function filePolicySummary() {
  return {
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    maxFileSizeLabel: MAX_FILE_SIZE_LABEL,
    allowedExtensions: ALLOWED_FILE_TYPES.map((t) => t.ext),
    allowedTypesLabel: ALLOWED_TYPES_LABEL,
    types: ALLOWED_FILE_TYPES.map((t) => ({
      ext: t.ext,
      mime: t.mime,
      kind: t.kind,
      previewable: t.previewable,
      label: t.label,
    })),
    previewUnsupportedMessage: PREVIEW_UNSUPPORTED_MESSAGE,
  }
}

/**
 * 文件接口。路径挂在资源下（`/api/resources/:id/files/...`），
 * 因为文件的生命周期完全从属于资源。
 *
 * 授权一律用 `@DirectoryScope({kind:'resource'})`：目标目录由**资源的目录**决定，
 * 与资源本身的判定口径完全一致 —— 不会出现"看得到资源、却能/不能下载它"的分叉。
 */
@Controller('api/resources/:id/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  @RequirePermission('resource.view')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async list(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return { items: await this.files.list(actor, id) }
  }

  /**
   * 文件策略（允许的类型、大小上限、界面文案）。
   *
   * 前端本来就能从 `shared/file-policy.ts` 直接拿到同一份常量 —— 这个接口是给
   * **部署后想确认服务端到底按什么策略在跑**的人用的，也方便 E2E 断言
   * "前后端读的是同一个上限"。
   */
  @Get('policy')
  @RequirePermission('resource.view')
  async policy() {
    return filePolicySummary()
  }

  /** ① 申请上传地址（浏览器 PUT 之前调用）。 */
  @Post('upload-url')
  @RequirePermission('resource.update.own')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async uploadUrl(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UploadUrlDto,
  ) {
    return this.files.createUploadUrl(actor, id, dto)
  }

  /** ③+④ 校验并登记。 */
  @Post('register')
  @RequirePermission('resource.update.own')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async register(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: RegisterFileDto,
  ) {
    return this.files.register(actor, id, dto.uploadId)
  }

  @Get(':fileId/download')
  @RequirePermission('resource.download')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async download(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
  ) {
    return this.files.download(actor, id, fileId)
  }

  @Get(':fileId/preview')
  @RequirePermission('resource.download')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async preview(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
  ) {
    return this.files.preview(actor, id, fileId)
  }

  @Delete(':fileId')
  @RequirePermission('resource.update.own')
  @DirectoryScope({ kind: 'resource', param: 'id' })
  async remove(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
  ) {
    return this.files.remove(actor, id, fileId)
  }
}
