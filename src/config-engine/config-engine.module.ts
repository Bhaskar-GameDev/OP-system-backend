import { Global, Module } from '@nestjs/common';
import { OpConfigService } from './op-config.service';

/** Configuration engine (Phase 11). Global — any module resolves scoped config. */
@Global()
@Module({
  providers: [OpConfigService],
  exports: [OpConfigService],
})
export class ConfigEngineModule {}
