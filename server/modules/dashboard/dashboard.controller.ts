import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { CurrentTeacher } from '@server/modules/auth/auth.guard';
import type { AuthUser } from '@shared/api.interface';

@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  async getStats(@CurrentTeacher() teacher: AuthUser) {
    return this.dashboardService.getStats(teacher.id);
  }

  @Get('recent')
  async getRecent(
    @CurrentTeacher() teacher: AuthUser,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.dashboardService.getRecentUpdates(teacher.id, limitNum);
  }
}
