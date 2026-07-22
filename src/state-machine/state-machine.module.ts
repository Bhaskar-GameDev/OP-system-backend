import { Global, Module } from '@nestjs/common';
import { StateMachineService } from './state-machine.service';

/** Global: any domain module validates transitions through one service (Phase 12). */
@Global()
@Module({
  providers: [StateMachineService],
  exports: [StateMachineService],
})
export class StateMachineModule {}
