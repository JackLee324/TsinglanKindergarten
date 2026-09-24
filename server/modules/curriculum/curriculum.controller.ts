import { Controller, Get } from '@nestjs/common';
import { CurrentTeacherRoles } from '../auth/auth.guard';
import { CurriculumService } from './curriculum.service';
import type { ProgramStructure, RoleCode } from '@shared/api.interface';

@Controller('api/curriculum')
export class CurriculumController {
  constructor(private readonly curriculumService: CurriculumService) {}

  @Get('structure')
  getStructure(
    @CurrentTeacherRoles() roles: RoleCode[],
  ): ProgramStructure[] {
    return this.curriculumService.getStructure(roles);
  }

  @Get('folders')
  getFolders() {
    return this.curriculumService.getFolders();
  }

  @Get('roles')
  getRoles() {
    return this.curriculumService.getRoles();
  }
}
