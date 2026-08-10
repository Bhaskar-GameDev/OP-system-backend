import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from './common/redis/redis.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { TenantModule } from './common/tenant/tenant.module';
import { EventStoreModule } from './event-store/event-store.module';
import { StateMachineModule } from './state-machine/state-machine.module';
import { EncountersModule } from './encounters/encounters.module';
import { TokensModule } from './tokens/tokens.module';
import { CheckInModule } from './check-in/checkin.module';
import { OpQueueModule } from './queue/op-queue.module';
import { ConsultationModule } from './consultation/consultation.module';
import { OverrideModule } from './override/override.module';
import { ReadSideModule } from './read-side/read-side.module';
import { ConfigEngineModule } from './config-engine/config-engine.module';
import { OpHttpModule } from './op-http/op-http.module';
import { OpRealtimeModule } from './realtime/op-realtime.module';
import { OpPaymentsModule } from './op-payments/op-payments.module';
import { OpDoctorModule } from './op-doctor/op-doctor.module';
import { MigrationModule } from './migration/migration.module';
import { QueueEngineModule } from './queue-engine/queue-engine.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { PaymentsModule } from './payments/payments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ArchivalModule } from './archival/archival.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { AdminModule } from './admin/admin.module';
import { HospitalSetupModule } from './provisioning/hospital-setup.module';
import { ReceptionModule } from './reception/reception.module';
import { DoctorModule } from './doctor/doctor.module';
import { ProfileModule } from './profile/profile.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { VoiceModule } from './voice/voice.module';
import { DisplayModule } from './display/display.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { RequestContextMiddleware } from './common/observability/request-context.middleware';
import { HttpMetricsMiddleware } from './common/observability/http-metrics.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    EventStoreModule,
    StateMachineModule,
    ConfigEngineModule,
    EncountersModule,
    TokensModule,
    CheckInModule,
    OpQueueModule,
    ConsultationModule,
    OverrideModule,
    ReadSideModule,
    OpHttpModule,
    OpRealtimeModule,
    OpPaymentsModule,
    OpDoctorModule,
    MigrationModule,
    TenantModule,
    RedisModule,
    QueueEngineModule,
    AuthModule,
    BookingsModule,
    PaymentsModule,
    NotificationsModule,
    ArchivalModule,
    DiscoveryModule,
    AdminModule,
    HospitalSetupModule,
    ReceptionModule,
    DoctorModule,
    ProfileModule,
    IntegrationsModule,
    VoiceModule,
    DisplayModule,
    ObservabilityModule,
  ],
})
export class AppModule implements NestModule {
  /**
   * Applied to every route, including the public ones: a correlation id is
   * useful precisely when the caller is anonymous, and the metrics recorder
   * must not have a blind spot where the unauthenticated traffic lives.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware, HttpMetricsMiddleware).forRoutes('*');
  }
}
