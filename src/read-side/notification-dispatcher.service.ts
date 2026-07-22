import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { StoredEvent } from '../event-store/domain-event.types';
import { DomainEventType } from '../event-store/domain-event.types';
import {
  NOTIFICATION_PROVIDERS,
  NotificationChannel,
  NotificationProvider,
  OutboundNotification,
} from './notification-provider';

/**
 * Notification pipeline (ARCHITECTURE.md §11, Phase 10). Event-driven: it maps a
 * domain event to a patient-facing notification and fans out to the registered
 * providers. Purely reactive off the event stream, so a delivery failure can
 * never block a queue or payment operation.
 */
@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_PROVIDERS)
    private readonly providers: NotificationProvider[],
  ) {}

  /** Which event types produce a patient notification, and their template. */
  private template(
    event: StoredEvent,
  ): { key: string; title: string; body: (d: Record<string, unknown>) => string } | null {
    switch (event.type) {
      case DomainEventType.EncounterCreated:
        return { key: 'registration_successful', title: 'Registration confirmed', body: () => 'Your OP registration is confirmed. Please arrive and check in.' };
      case DomainEventType.PatientCheckedIn:
        return { key: 'check_in_confirmed', title: 'Checked in', body: () => 'You are checked in. Your token will be issued shortly.' };
      case DomainEventType.TokenIssued:
        return { key: 'token_generated', title: 'Token issued', body: (d) => `Your token is ${d.displayNumber}.` };
      case DomainEventType.QueueEntered:
        return { key: 'queue_position', title: 'You are in the queue', body: () => 'You are in the queue. Track your live position in the app.' };
      case DomainEventType.PatientCalled:
        return { key: 'doctor_calling', title: "It's your turn", body: () => 'The doctor is calling you now. Please proceed to the room.' };
      case DomainEventType.ConsultationCompleted:
        return { key: 'consultation_complete', title: 'Consultation complete', body: () => 'Your consultation is complete. Prescription/summary is available.' };
      default:
        return null;
    }
  }

  /** Handle one event: render + fan out. Returns the notifications sent (for tests). */
  async handle(event: StoredEvent): Promise<OutboundNotification[]> {
    const tpl = this.template(event);
    if (!tpl) return [];

    // Resolve the recipient encounter -> patient (skip Consultation-stream events
    // whose encounter link is in the payload).
    const encounterId =
      event.streamType === 'Encounter'
        ? event.streamId
        : (event.payload.encounterId as string | undefined);
    if (!encounterId) return [];

    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
      select: { patientId: true },
    });
    if (!enc) return [];
    const patient = await this.prisma.patient.findUnique({
      where: { id: enc.patientId },
      select: { id: true, mobile: true, fcmToken: true },
    });
    if (!patient) return [];

    const sent: OutboundNotification[] = [];
    const channels = this.recipientChannels(patient);
    for (const ch of channels) {
      const n: OutboundNotification = {
        channel: ch.channel,
        to: ch.to,
        templateKey: tpl.key,
        title: tpl.title,
        body: tpl.body(event.payload),
        data: { encounterId, type: event.type },
      };
      for (const p of this.providers) {
        if (p.channels.includes(ch.channel)) {
          await p.send(n);
        }
      }
      sent.push(n);
    }
    return sent;
  }

  private recipientChannels(patient: {
    id: string;
    mobile: string;
    fcmToken: string | null;
  }): { channel: NotificationChannel; to: string }[] {
    const out: { channel: NotificationChannel; to: string }[] = [];
    if (patient.fcmToken) out.push({ channel: 'PUSH', to: patient.fcmToken });
    out.push({ channel: 'IN_APP', to: patient.id });
    out.push({ channel: 'SMS', to: patient.mobile });
    return out;
  }
}
