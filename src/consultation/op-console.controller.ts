import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AuthedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TenantScopeGuard } from '../common/tenant/tenant-scope';
import { TenantService } from '../common/tenant/tenant.service';
import { ConsultationEngineService } from './consultation-engine.service';

class CallNextBody {
  @IsOptional() @IsString() category?: string;
}
class StartBody {
  @IsOptional() @IsString() roomId?: string;
}
class TransferBody {
  @IsString() toDoctorId!: string;
}

/**
 * Doctor console (ARCHITECTURE.md §6/§7). Every action goes through the
 * consultation state machine and emits a domain event. Overrides/emergencies
 * live elsewhere — nothing here renumbers the queue.
 *
 * Tenant scope: session/encounter actions assert the resource's doctor is in the
 * caller's scope. A DOCTOR may only drive their OWN session.
 */
@Controller('op')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('DOCTOR', 'STAFF', 'ADMIN')
export class OpConsoleController {
  constructor(
    private readonly engine: ConsultationEngineService,
    private readonly tenant: TenantService,
  ) {}

  private actor(req: AuthedRequest): string | undefined {
    return req.user?.sub;
  }

  /** POST /op/sessions/:id/call-next — call the next patient per policy. */
  @Post('sessions/:id/call-next')
  async callNext(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CallNextBody,
  ) {
    await this.tenant.assertSessionAccess(req.user, id);
    return this.engine.callNext(id, {
      category: body.category,
      actorId: this.actor(req),
    });
  }

  /** POST /op/encounters/:id/start — begin the in-room consultation. */
  @Post('encounters/:id/start')
  async start(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: StartBody,
  ) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.engine.startConsultation(id, {
      roomId: body.roomId,
      actorId: this.actor(req),
    });
  }

  /** POST /op/encounters/:id/complete — finish the consultation. */
  @Post('encounters/:id/complete')
  async complete(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.engine.complete(id, { actorId: this.actor(req) });
  }

  /** POST /op/encounters/:id/skip — send to the back of the line. */
  @Post('encounters/:id/skip')
  async skip(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.engine.skip(id, { actorId: this.actor(req) });
  }

  /** POST /op/encounters/:id/recall — recall a skipped/no-show patient. */
  @Post('encounters/:id/recall')
  async recall(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.engine.recall(id, { actorId: this.actor(req) });
  }

  /** POST /op/encounters/:id/no-show — mark as no-show. */
  @Post('encounters/:id/no-show')
  async noShow(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertEncounterAccess(req.user, id);
    return this.engine.noShow(id, { actorId: this.actor(req) });
  }

  /** POST /op/encounters/:id/transfer — transfer to another doctor. */
  @Post('encounters/:id/transfer')
  async transfer(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: TransferBody,
  ) {
    // Both the source encounter AND the destination doctor must be in scope.
    await this.tenant.assertEncounterAccess(req.user, id);
    await this.tenant.assertQueueAccess(req.user, body.toDoctorId);
    return this.engine.transfer(id, body.toDoctorId, {
      actorId: this.actor(req),
    });
  }

  /** POST /op/sessions/:id/pause — pause the session (doctor stepped away). */
  @Post('sessions/:id/pause')
  async pause(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertSessionAccess(req.user, id);
    return this.engine.pauseSession(id);
  }

  /** POST /op/sessions/:id/resume — resume a paused session. */
  @Post('sessions/:id/resume')
  async resume(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.tenant.assertSessionAccess(req.user, id);
    return this.engine.resumeSession(id);
  }
}
