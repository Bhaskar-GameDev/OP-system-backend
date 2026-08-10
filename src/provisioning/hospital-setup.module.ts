import { Module } from '@nestjs/common';
import { HospitalSetupController } from './hospital-setup.controller';
import { HospitalSetupService } from './hospital-setup.service';

/**
 * Tenant bootstrap (POST /setup/hospital). Kept in its own module rather than
 * folded into AdminModule: everything in AdminModule is guarded and
 * hospital-scoped, and this one route is neither — the separation keeps that
 * distinction visible.
 *
 * PasswordService and LoginThrottleService come from the @Global AuthModule.
 */
@Module({
  controllers: [HospitalSetupController],
  providers: [HospitalSetupService],
})
export class HospitalSetupModule {}
