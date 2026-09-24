import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ResourcesService } from './resources.service';
import {
  ResourceListQueryDto,
  CreateResourceDto,
  UpdateResourceDto,
  ResourceIdParamDto,
  RecycleBinQueryDto,
  RegisterFileDto,
} from './resources.dto';
import { CurrentTeacher } from '@server/modules/auth/auth.guard';
import { RequirePermission } from '@server/modules/authz/permission.decorator';
import { getClientIp } from '@server/common/http/client-ip';
import type { AuthUser } from '@shared/api.interface';

/**
 * Resource endpoints.
 *
 * IMPORTANT HISTORY: before phase 5 this controller declared NO authorization at
 * all — every route was reachable by ANY authenticated account (a 配班 teacher
 * could create, edit and delete resources by calling the API directly, because
 * only the UI hid the buttons). Each route now declares the capability it needs.
 *
 * The service layer keeps its own subject-level checks (which resource rows a
 * caller may touch); the decorator answers "may this account attempt the
 * operation at all", the service answers "may it do so to THIS row". Both are
 * required — see RBAC.md and PRODUCTION_READINESS.md §D-11.
 */
@Controller('api/resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  /**
   * Client IP for audit records.
   * Delegates to the shared trust-aware resolver — see client-ip.ts for why the
   * previous hand-parsed `x-forwarded-for` was unsafe.
   */
  private getIp(req: Request): string | undefined {
    return getClientIp(req) || undefined;
  }

  @Get()
  @RequirePermission('resource.view')
  async listResources(
    @Query() query: ResourceListQueryDto,
    @CurrentTeacher() teacher: AuthUser,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    return this.resourcesService.listResources(query, teacher.id, ip);
  }

  /**
   * The caller's own resources.
   *
   * MUST BE DECLARED BEFORE `@Get(':id')`. The client has always called
   * `/api/resources/mine`, but no such route existed, so the request fell through
   * to `@Get(':id')` with id='mine'. That reached the database as a UUID
   * comparison against a non-UUID literal and surfaced as a 500 (previously),
   * i.e. the "我的资源" page could never load. Route order is load-bearing here:
   * Express matches in declaration order, so moving this below `:id` silently
   * re-breaks it.
   *
   * `getMyResources()` already existed in the service and had NO caller at all.
   */
  @Get('mine')
  @RequirePermission('resource.view')
  async getMyResources(
    @CurrentTeacher() teacher: AuthUser,
    @Query() query: ResourceListQueryDto,
  ) {
    return this.resourcesService.getMyResources(teacher.id, {
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  /**
   * The recycle bin.
   *
   * MUST BE DECLARED BEFORE `@Get(':id')`, for exactly the reason documented on
   * `mine` above: Express matches in declaration order, so a literal path placed
   * after `:id` is never reached — the request arrives as id='recycle-bin', which
   * is not a UUID and would surface as a 404/500 instead of the bin.
   *
   * Gated by `resource.restore` (held by principal / curriculum_director /
   * super_admin by default): being able to SEE the bin and being able to empty it
   * are the same capability, and the service performs no second filter — the
   * decorator is the gate.
   */
  @Get('recycle-bin')
  @RequirePermission('resource.restore')
  async listRecycleBin(
    @Query() query: RecycleBinQueryDto,
  ) {
    return this.resourcesService.listDeletedResources({
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get(':id')
  @RequirePermission('resource.view')
  async getResource(
    @Param() params: ResourceIdParamDto,
    @CurrentTeacher() teacher: AuthUser,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    return this.resourcesService.getResource(params.id, teacher.id, ip);
  }

  @Post()
  @RequirePermission('resource.create')
  async createResource(
    @CurrentTeacher() teacher: AuthUser,
    @Body() dto: CreateResourceDto,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    return this.resourcesService.createResource(dto, teacher.id, ip);
  }

  @Patch(':id')
  @RequirePermission('resource.update')
  async updateResource(
    @CurrentTeacher() teacher: AuthUser,
    @Param() params: ResourceIdParamDto,
    @Body() dto: UpdateResourceDto,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    return this.resourcesService.updateResource(
      params.id,
      dto,
      teacher.id,
      ip,
    );
  }

  @Delete(':id')
  @RequirePermission('resource.delete')
  async deleteResource(
    @CurrentTeacher() teacher: AuthUser,
    @Param() params: ResourceIdParamDto,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    await this.resourcesService.deleteResource(params.id, teacher.id, ip);
    return { success: true };
  }

  /**
   * Restore a resource from the recycle bin.
   *
   * POST (not PATCH/DELETE) because it is a state-changing command on a
   * sub-resource with its own audit action (`resource_restore`), mirroring
   * `:id/submit-review`.
   */
  @Post(':id/restore')
  @RequirePermission('resource.restore')
  async restoreResource(
    @CurrentTeacher() teacher: AuthUser,
    @Param() params: ResourceIdParamDto,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    await this.resourcesService.restoreResource(params.id, teacher.id, ip);
    return { success: true };
  }

  /**
   * Register the file that was uploaded for a resource.
   *
   * This is the SERVER-SIDE validation boundary for uploads: name sanitisation,
   * the extension/MIME allowlist, the size ceiling and the magic-byte consistency
   * check all run here BEFORE anything is written, and both the rejection and the
   * success are audited. `storage.upload` is required in addition to
   * `resource.update` because attaching bytes is an upload, not a metadata edit.
   */
  @Post(':id/file')
  @RequirePermission('resource.update', 'storage.upload')
  async registerFile(
    @CurrentTeacher() teacher: AuthUser,
    @Param() params: ResourceIdParamDto,
    @Body() dto: RegisterFileDto,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    return this.resourcesService.registerFile(
      params.id,
      teacher.id,
      {
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        head: dto.head,
        fileBucketId: dto.fileBucketId,
        filePath: dto.filePath,
      },
      ip,
    );
  }

  @Post(':id/submit-review')
  @RequirePermission('resource.submit_review')
  async submitReview(
    @CurrentTeacher() teacher: AuthUser,
    @Param() params: ResourceIdParamDto,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    return this.resourcesService.submitReview(params.id, teacher.id, ip);
  }

  @Get(':id/download')
  @RequirePermission('resource.download')
  async downloadResource(
    @Res() res: Response,
    @Param() params: ResourceIdParamDto,
    @CurrentTeacher() teacher: AuthUser,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    const { downloadUrl, fileName } =
      await this.resourcesService.getDownloadUrl(params.id, teacher.id, ip);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(fileName)}"`,
    );
    res.redirect(HttpStatus.FOUND, downloadUrl);
  }

  @Get(':id/storybook-cover/:index')
  @RequirePermission('resource.view')
  async getStorybookCover(
    @Res() res: Response,
    @Param() params: ResourceIdParamDto & { index: string },
    @CurrentTeacher() teacher: AuthUser,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    const index = parseInt(params.index, 10);
    if (isNaN(index) || index < 0) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'Invalid index' });
      return;
    }
    const { stream, contentType, fileName } =
      await this.resourcesService.getStorybookCoverStream(
        params.id,
        index,
        teacher.id,
        ip,
      );

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(fileName)}"`,
    );
    res.setHeader('Cache-Control', 'public, max-age=86400');
    stream.pipe(res);
  }
}
