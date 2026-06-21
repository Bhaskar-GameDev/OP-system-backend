import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from './common/redis/redis.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { QueueEngineModule } from './queue-engine/queue-engine.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { PaymentsModule } from './payments/payments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ArchivalModule } from './archival/archival.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { AdminModule } from './admin/admin.module';
import { ReceptionModule } from './reception/reception.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    QueueEngineModule,
    AuthModule,
    BookingsModule,
    PaymentsModule,
    NotificationsModule,
    ArchivalModule,
    DiscoveryModule,
    AdminModule,
    ReceptionModule,
  ],
})
export class AppModule {}
