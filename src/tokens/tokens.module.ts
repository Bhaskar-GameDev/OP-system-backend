import { Module } from '@nestjs/common';
import { RedisModule } from '../common/redis/redis.module';
import { TokenSeriesService } from './token-series.service';

/** Token engine (Phase 4). Redis for atomic allocation; globals for store/SM. */
@Module({
  imports: [RedisModule],
  providers: [TokenSeriesService],
  exports: [TokenSeriesService],
})
export class TokensModule {}
