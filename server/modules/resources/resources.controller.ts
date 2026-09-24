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
} from './resources.dto';
import { CurrentTeacher } from '@server/modules/auth/auth.guard';
import type { AuthUser } from '@shared/api.interface';

@Controller('api/resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  private getIp(req: Request): string | undefined {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0]?.trim();
    }
    return req.ip;
  }

  @Get()
  async listResources(
    @Query() query: ResourceListQueryDto,
    @CurrentTeacher() teacher: AuthUser,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    return this.resourcesService.listResources(query, teacher.id, ip);
  }

  @Get(':id')
  async getResource(
    @Param() params: ResourceIdParamDto,
    @CurrentTeacher() teacher: AuthUser,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    return this.resourcesService.getResource(params.id, teacher.id, ip);
  }

  @Post()
  async createResource(
    @CurrentTeacher() teacher: AuthUser,
    @Body() dto: CreateResourceDto,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    return this.resourcesService.createResource(dto, teacher.id, ip);
  }

  @Patch(':id')
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
  async deleteResource(
    @CurrentTeacher() teacher: AuthUser,
    @Param() params: ResourceIdParamDto,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    await this.resourcesService.deleteResource(params.id, teacher.id, ip);
    return { success: true };
  }

  @Post(':id/submit-review')
  async submitReview(
    @CurrentTeacher() teacher: AuthUser,
    @Param() params: ResourceIdParamDto,
    @Req() req: Request,
  ) {
    const ip = this.getIp(req);
    return this.resourcesService.submitReview(params.id, teacher.id, ip);
  }

  @Get(':id/download')
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
