import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TenantScopeGuard } from '../common/tenant/tenant-scope';
import { TenantService } from '../common/tenant/tenant.service';
import { OpQueueService } from './op-queue.service';

/**
 * Queue surface (ARCHITECTURE.md §6). Enqueue places a token-holding encounter
 * into the ONE queue for its session; ordering is decided by the queue engine
 * (queue order + category rules + policy), never by registration source.
 */
@Controller('op')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('STAFF', 'ADMIN', 'DOCTOR')
export class OpQueueController {
  constructor(
    private readonly queue: OpQueueService,
    private readonly tenant: TenantService,
  ) {}

  /** POST /op/encounters/:id/enqueue — add a token-holding encounter to the queue. */
  @Post('encounters/:id/enqueue')
  async enqueue(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.queue.enqueue(id);
  }

  /** GET /op/sessions/:id/queue — the live waiting line for a session. */
  @Get('sessions/:id/queue')
  async waiting(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertSessionAccess(req.user, id);
    return this.queue.listWaiting(id);
  }
}
