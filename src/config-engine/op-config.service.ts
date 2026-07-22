import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';

export type ConfigScopeType = 'HOSPITAL' | 'CLINIC' | 'DOCTOR';

export interface ConfigScope {
  hospitalId?: string;
  clinicId?: string;
  doctorId?: string;
}

/**
 * Configuration engine (ARCHITECTURE.md §10, Phase 11).
 *
 * Generic scoped key/value for hospital-specific behaviour not already covered
 * by a dedicated config table. Resolution is DOCTOR → CLINIC → HOSPITAL → code
 * default (most specific wins). Every change is event-sourced (ConfigChanged),
 * so config is versioned and per-branch rollout / rollback come for free.
 */
@Injectable()
export class OpConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
  ) {}

  /** Resolve a config value, most-specific scope first, else the default. */
  async get<T>(key: string, scope: ConfigScope, fallback: T): Promise<T> {
    const lookups: [ConfigScopeType, string | undefined][] = [
      ['DOCTOR', scope.doctorId],
      ['CLINIC', scope.clinicId],
      ['HOSPITAL', scope.hospitalId],
    ];
    for (const [scopeType, scopeId] of lookups) {
      if (!scopeId) continue;
      const row = await this.prisma.hospitalConfig.findUnique({
        where: { uq_config: { scopeType, scopeId, key } },
      });
      if (row) return row.value as T;
    }
    return fallback;
  }

  /** Set a scoped config value and emit ConfigChanged. */
  async set(
    scopeType: ConfigScopeType,
    scopeId: string,
    key: string,
    value: unknown,
    actorId?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.hospitalConfig.upsert({
        where: { uq_config: { scopeType, scopeId, key } },
        create: { scopeType, scopeId, key, value: value as object },
        update: { value: value as object },
      });
      const streamId = `${scopeType}:${scopeId}`;
      const version = await this.events.currentVersion('Config', streamId, tx);
      await this.events.append(
        {
          streamType: 'Config',
          streamId,
          type: DomainEventType.ConfigChanged,
          payload: { key, value },
          metadata: { actorId },
        },
        version,
        tx,
      );
    });
  }

  // ── typed helpers for engine behaviours (defaults are the safe baseline) ──

  /** Reception combined path auto-issues a token on check-in? Default false. */
  checkInAutoIssueToken(scope: ConfigScope): Promise<boolean> {
    return this.get('checkin.autoIssueToken', scope, false);
  }

  /** Clinic working hours, e.g. {open:"09:00",close:"21:00"}. */
  workingHours(scope: ConfigScope): Promise<{ open: string; close: string }> {
    return this.get('clinic.workingHours', scope, {
      open: '09:00',
      close: '21:00',
    });
  }
}
