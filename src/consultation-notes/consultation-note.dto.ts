/**
 * Consultation-note contracts. Same projection discipline as the rest of the
 * codebase: a fresh object built from an explicit allow-list, never a spread of
 * the raw model. Dates go out as strings (followUpDate YYYY-MM-DD, timestamps
 * ISO) so the wire shape is stable across timezones.
 */

export interface ConsultationNoteView {
  bookingId: string;
  doctorId: string;
  notes: string;
  diagnosis: string | null;
  prescriptions: string | null;
  followUpDate: string | null; // YYYY-MM-DD
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** Write payload from the doctor app. Everything but bookingId is optional. */
export interface SaveConsultationNoteInput {
  bookingId: string;
  notes?: string;
  diagnosis?: string | null;
  prescriptions?: string | null;
  followUpDate?: string | null; // YYYY-MM-DD
}

type NoteLike = {
  bookingId: string;
  doctorId: string;
  notes: string;
  diagnosis: string | null;
  prescriptions: string | null;
  followUpDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toConsultationNoteView(n: NoteLike): ConsultationNoteView {
  return {
    bookingId: n.bookingId,
    doctorId: n.doctorId,
    notes: n.notes,
    diagnosis: n.diagnosis ?? null,
    prescriptions: n.prescriptions ?? null,
    followUpDate: n.followUpDate ? n.followUpDate.toISOString().slice(0, 10) : null,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}
