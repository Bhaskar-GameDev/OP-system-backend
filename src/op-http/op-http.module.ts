import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EncountersModule } from '../encounters/encounters.module';
import { CheckInModule } from '../check-in/checkin.module';
import { TokensModule } from '../tokens/tokens.module';
import { OpQueueModule } from '../queue/op-queue.module';
import { ConsultationModule } from '../consultation/consultation.module';
import { OverrideModule } from '../override/override.module';
import { ReadSideModule } from '../read-side/read-side.module';
import { OpRegistrationController } from '../encounters/op-registration.controller';
import { OpCheckInController } from '../check-in/op-checkin.controller';
import { OpTokenController } from '../tokens/op-token.controller';
import { OpQueueController } from '../queue/op-queue.controller';
import { OpConsoleController } from '../consultation/op-console.controller';
import { OpOverrideController } from '../override/op-override.controller';
import { OpReadController } from '../read-side/op-read.controller';
import { OpConfigController } from '../config-engine/op-config.controller';

/**
 * HTTP surface for the token-based OP engine (Task 1). Deliberately SEPARATE
 * from the engine modules: those stay pure domain (no controllers, no auth
 * dependency) so they can be composed directly in unit/integration specs without
 * dragging in the auth graph. This module is the ONE place that couples the
 * engine services to the transport + auth/tenant guards, and it is imported only
 * by AppModule.
 *
 * Guards (JwtAuthGuard/RolesGuard) come from the @Global AuthModule; TenantService
 * and OpConfigService come from their @Global modules.
 */
@Module({
  imports: [
    AuthModule,
    EncountersModule,
    CheckInModule,
    TokensModule,
    OpQueueModule,
    ConsultationModule,
    OverrideModule,
    ReadSideModule,
  ],
  controllers: [
    OpRegistrationController,
    OpCheckInController,
    OpTokenController,
    OpQueueController,
    OpConsoleController,
    OpOverrideController,
    OpReadController,
    OpConfigController,
  ],
})
export class OpHttpModule {}
