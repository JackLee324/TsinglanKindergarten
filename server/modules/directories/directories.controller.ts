import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentTeacher, CurrentTeacherRoles } from '../auth/auth.guard';
import { CurrentAuthz, RequirePermission } from '@server/modules/authz/permission.decorator';
import { DirectoriesService, type DirectoryActor } from './directories.service';
import { CreateDirectoryFolderDto, UpdateDirectoryNodeDto } from './directories.dto';
import type { EffectivePermissions } from '@shared/rbac';
import type {
  AuthUser,
  DirectoryNode,
  DirectoryTreeResponse,
  RoleCode,
} from '@shared/api.interface';

/**
 * 目录树接口（PDF《教师平台》权威结构）。
 *
 * 权限刻意用 `curriculum.view`（声明式），而不是内联 `roles.includes('principal')`：
 * 与 audit 那次修复同一理由 —— 让「谁能看目录」成为可配置的数据，
 * 而不是散在路由里的硬编码角色判断。
 *
 * 该权限由 7 个角色默认持有（principal / curriculum_director / prek_head / k_head /
 * pe_specialist / prek_assistant / k_assistant），super_admin 由 SYSTEM_ROLES 覆盖，
 * visitor 刻意没有 —— visitor「不能进入课程内容」（AGENTS.md），目录即课程内容。
 *
 * 注意：权限只决定「能不能调这个接口」。**具体能看到树里的哪些分支**由
 * DirectoriesService 按 roleSubjectScope / programsVisibleForStructure 逐节点过滤，
 * 两者不是同一件事，缺一不可。
 */
@Controller('api/directories')
export class DirectoriesController {
  constructor(private readonly directoriesService: DirectoriesService) {}

  /** 整棵目录树（按调用方角色过滤）。 */
  @Get('tree')
  @RequirePermission('curriculum.view')
  async getTree(
    @CurrentTeacherRoles() roles: RoleCode[],
    @CurrentAuthz() authz: EffectivePermissions,
    @Query('includeDisabled') includeDisabled?: string,
  ): Promise<DirectoryTreeResponse> {
    // 用**生效权限**（含按账号的授予/拒绝）而不是 roles 去算 canManage：
    // 前端据此显示/隐藏"新建文件夹"入口，必须与写接口的真实判定一致。
    const canManage = (authz?.permissions ?? []).includes('curriculum.manage');
    // 只有管理权才允许看到已停用节点。非管理员传了这个参数也拿不到 ——
    // 否则它会变成"绕过停用"的入口，而停用本身是一种管理动作。
    const wantsDisabled = includeDisabled === 'true' || includeDisabled === '1';
    return this.directoriesService.getTree(roles, canManage, wantsDisabled);
  }

  /**
   * 单个节点及其子树。
   *
   * `code` 用 `:code` 会与 `:` 冲突（目录 code 本身就含冒号，如 `k:chinese:reading`），
   * 所以走查询参数而不是路径参数 —— 路径参数在这里会需要 URL 编码，
   * 而编码过的冒号在不同代理/网关下的解码行为并不一致。
   */
  @Get('node')
  @RequirePermission('curriculum.view')
  async getNode(
    @Query('code') code: string,
    @CurrentTeacherRoles() roles: RoleCode[],
  ): Promise<DirectoryNode> {
    return this.directoriesService.getNodeByCode(code ?? '', roles);
  }

  // ---------------------------------------------------------------------------
  // 写路径（§24/§25/§26）—— 「允许自建文件夹」
  //
  // 全部要求 `curriculum.manage`（highRisk）。今天只有 principal 与超级管理员持有它；
  // 要让别的角色也能维护目录，是**权限配置**的改动，不是代码改动 —— 这正是把
  // 内联 `roles.includes('principal')` 换成声明式权限的意义。
  //
  // 服务层还有三条自己的规则（父节点必须允许自建 / 系统节点不可改删 / 非空不可删），
  // 接口层的权限只是第一道门。
  // ---------------------------------------------------------------------------

  /** 在允许自建的资料夹下新建子文件夹。 */
  @Post('folder')
  @RequirePermission('curriculum.manage')
  async createFolder(
    @Body() dto: CreateDirectoryFolderDto,
    @CurrentTeacher() teacher: AuthUser,
  ): Promise<DirectoryNode> {
    return this.directoriesService.createFolder(dto, actorOf(teacher));
  }

  /**
   * 重命名 / 改描述（仅自建节点）。
   *
   * 用 `:code` 路径参数在这里是安全的：code 里虽然含 `:`，但 Express 的
   * 路径段解析只按 `/` 切分，冒号在路径段内部不影响匹配。
   * （读接口用查询参数是因为 `?code=` 更便于前端拼接，两者并不矛盾。）
   */
  @Patch('node/:code')
  @RequirePermission('curriculum.manage')
  async updateNode(
    @Param('code') code: string,
    @Body() dto: UpdateDirectoryNodeDto,
    @CurrentTeacher() teacher: AuthUser,
  ): Promise<DirectoryNode> {
    return this.directoriesService.updateNode(code, dto, actorOf(teacher));
  }

  /** 删除自建文件夹（必须无子节点）。 */
  @Delete('node/:code')
  @HttpCode(204)
  @RequirePermission('curriculum.manage')
  async deleteNode(
    @Param('code') code: string,
    @CurrentTeacher() teacher: AuthUser,
  ): Promise<void> {
    await this.directoriesService.deleteNode(code, actorOf(teacher));
  }
}

/** 把当前登录教师转成服务层需要的审计身份。 */
function actorOf(teacher: AuthUser | undefined): DirectoryActor {
  return { teacherId: teacher?.id, teacherName: teacher?.name };
}
