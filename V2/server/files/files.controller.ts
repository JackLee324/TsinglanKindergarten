import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common'
import { FilesService } from './files.service'
import { RegisterFileDto, UploadUrlDto } from '../resources/resources.dto'
import { CurrentUser, DirectoryScope, RequirePermission } from '../common/decorators'
import type { AuthUser } from '../common/auth-user'

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
  async list(@Param('id') id: string) {
    return { items: await this.files.list(id) }
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
    return this.files.register(actor, id, dto)
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
