import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

// Patient self-service profile (name / age / gender). PrismaService is global.
@Module({
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
