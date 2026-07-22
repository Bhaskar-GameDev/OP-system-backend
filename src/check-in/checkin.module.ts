import { Module } from '@nestjs/common';
import { TokensModule } from '../tokens/tokens.module';
import { CheckInService } from './checkin.service';

/** Check-in (Phase 3). Depends on the token engine for the combined desk path. */
@Module({
  imports: [TokensModule],
  providers: [CheckInService],
  exports: [CheckInService],
})
export class CheckInModule {}
