import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EncounterStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConsultationNotesService } from '../consultation-notes/consultation-notes.service';
import {
  ConsultationNoteView,
  SaveConsultationNoteInput,
} from '../consultation-notes/consultation-note.dto';

export interface OpCompletedEntry {
  encounterId: string;
  bookingId: string; // = encounterId; the note key the console uses (op note endpoints)
  tokenNumber: string | null;
  patientName: string | null;
  consultationEndedAt: string | null;
  hasNote: boolean;
}

/**
 * Doctor console read/notes for the token engine (op mode). Notes reuse the
 * existing `ConsultationNote` storage by resolving an encounter to its linked
 * legacy bookingId (the backfill column or the dual-write channelMeta), so no
 * schema change is needed. A purely new-native encounter (no linked booking)
 * cannot carry a note yet — that is the one case notes are unavailable.
 */
@Injectable()
export class OpDoctorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notes: ConsultationNotesService,
  ) {}

  /** Today's completed encounters for the doctor, with note presence. */
  async completed(doctorId: string): Promise<OpCompletedEntry[]> {
    const encounters = await this.prisma.encounter.findMany({
      where: { doctorId, status: EncounterStatus.COMPLETED },
      select: { id: true, patientId: true, legacyBookingId: true },
    });
    if (encounters.length === 0) return [];

    const ids = encounters.map((e) => e.id);
    const [tokens, patients, consults] = await Promise.all([
      this.prisma.token.findMany({ where: { encounterId: { in: ids } }, select: { encounterId: true, displayNumber: true } }),
      this.prisma.patient.findMany({ where: { id: { in: encounters.map((e) => e.patientId) } }, select: { id: true, name: true } }),
      this.prisma.consultation.findMany({ where: { encounterId: { in: ids } }, select: { encounterId: true, endedAt: true } }),
    ]);
    const tokenBy = new Map(tokens.map((t) => [t.encounterId, t.displayNumber]));
    const nameBy = new Map(patients.map((p) => [p.id, p.name]));
    const endedBy = new Map(consults.map((c) => [c.encounterId, c.endedAt]));

    // hasNote: resolve each encounter -> legacy bookingId, then which have a note.
    const bookingByEnc = new Map<string, string>();
    for (const e of encounters) {
      const b = await this.resolveBookingId(e.id, e.legacyBookingId);
      if (b) bookingByEnc.set(e.id, b);
    }
    const noted = bookingByEnc.size
      ? new Set(
          (
            await this.prisma.consultationNote.findMany({
              where: { bookingId: { in: [...bookingByEnc.values()] } },
              select: { bookingId: true },
            })
          ).map((n) => n.bookingId),
        )
      : new Set<string>();

    return encounters
      .map((e) => ({
        encounterId: e.id,
        bookingId: e.id,
        tokenNumber: tokenBy.get(e.id) ?? null,
        patientName: nameBy.get(e.patientId) ?? null,
        consultationEndedAt: endedBy.get(e.id)?.toISOString() ?? null,
        hasNote: (() => {
          const b = bookingByEnc.get(e.id);
          return b ? noted.has(b) : false;
        })(),
      }))
      .sort((a, b) => (a.consultationEndedAt ?? '').localeCompare(b.consultationEndedAt ?? ''));
  }

  /** The doctor's note for an encounter, or null. */
  async getNote(
    doctorId: string,
    encounterId: string,
  ): Promise<ConsultationNoteView | null> {
    const bookingId = await this.mustOwnAndResolve(doctorId, encounterId);
    if (!bookingId) return null; // no linked booking -> no note surface
    return this.notes.getForDoctor(doctorId, bookingId);
  }

  /** Upsert the doctor's note for an encounter (via its linked bookingId). */
  async saveNote(
    doctorId: string,
    encounterId: string,
    input: Omit<SaveConsultationNoteInput, 'bookingId'>,
  ): Promise<ConsultationNoteView> {
    const bookingId = await this.mustOwnAndResolve(doctorId, encounterId);
    if (!bookingId) {
      throw new BadRequestException('notes require a linked booking for this encounter');
    }
    return this.notes.saveForDoctor(doctorId, { ...input, bookingId });
  }

  /** Assert the doctor owns the encounter, and resolve its legacy bookingId. */
  private async mustOwnAndResolve(
    doctorId: string,
    encounterId: string,
  ): Promise<string | null> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
      select: { doctorId: true, legacyBookingId: true },
    });
    if (!enc) throw new NotFoundException('encounter not found');
    if (enc.doctorId !== doctorId) {
      throw new ForbiddenException('encounter belongs to another doctor');
    }
    return this.resolveBookingId(encounterId, enc.legacyBookingId);
  }

  /** encounterId -> legacy bookingId (backfill column or mirror channelMeta). */
  private async resolveBookingId(
    encounterId: string,
    legacyBookingId: string | null,
  ): Promise<string | null> {
    if (legacyBookingId) return legacyBookingId;
    const reg = await this.prisma.registration.findFirst({
      where: { encounterId },
      select: { channelMeta: true },
    });
    const meta = reg?.channelMeta as { legacyBookingId?: string } | null;
    return meta?.legacyBookingId ?? null;
  }
}
