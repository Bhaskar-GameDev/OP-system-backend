import { Module } from '@nestjs/common';
import { PasswordService } from '../auth/password.service';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';

/**
 * Admin Portal — clinic edit, doctor/staff CRUD (all token-scoped to the
 * admin's own clinic), the daily analytics summary job (2:30am, after the
 * 2am archival sweep) and analytics read surface, plus the on-demand
 * operational reports (ADMIN + STAFF) for the analytics dashboard.
 */
@Module({
  controllers: [AdminController, AnalyticsController, ReportsController],
  providers: [AdminService, AnalyticsService, ReportsService, PasswordService],
  exports: [AnalyticsService],
})
export class AdminModule {}
