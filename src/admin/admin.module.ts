import { Module } from '@nestjs/common';
import { PasswordService } from '../auth/password.service';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

/**
 * Admin Portal — clinic edit, doctor/staff CRUD (all token-scoped to the
 * admin's own clinic), plus the daily analytics summary job (2:30am, after the
 * 2am archival sweep) and the analytics read surface.
 */
@Module({
  controllers: [AdminController, AnalyticsController],
  providers: [AdminService, AnalyticsService, PasswordService],
  exports: [AnalyticsService],
})
export class AdminModule {}
