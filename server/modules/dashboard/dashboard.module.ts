import { Module } from '@nestjs/common';
import { AuthzModule } from '@server/modules/authz/authz.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  // §3：数据范围判定统一走 AuthorizationService。
  imports: [AuthzModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
