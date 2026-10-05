import { Controller, Get, Query } from '@nestjs/common';
import { CurrentTeacherRoles } from '../auth/auth.guard';
import { RequirePermission } from '@server/modules/authz/permission.decorator';
import { DirectoriesService } from './directories.service';
import type { DirectoryNode, DirectoryTreeResponse, RoleCode } from '@shared/api.interface';

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
  async getTree(@CurrentTeacherRoles() roles: RoleCode[]): Promise<DirectoryTreeResponse> {
    return this.directoriesService.getTree(roles);
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
}
