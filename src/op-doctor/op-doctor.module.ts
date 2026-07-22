import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConsultationNotesModule } from '../consultation-notes/consultation-notes.module';
import { OpDoctorService } from './op-doctor.service';
import { OpDoctorController } from './op-doctor.controller';

/**
 * Doctor console reads + notes for the token engine (op mode). Reuses the shared
 * ConsultationNotesService; PrismaService + TenantService are global.
 */
@Module({
  imports: [AuthModule, ConsultationNotesModule],
  providers: [OpDoctorService],
  controllers: [OpDoctorController],
  exports: [OpDoctorService],
})
export class OpDoctorModule {}
