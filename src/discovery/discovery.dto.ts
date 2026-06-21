/**
 * Public projection DTOs for discovery. These mappers build a FRESH object with
 * an explicit field allow-list — they never spread the input. Internal/auth
 * fields (password_hash, username, …) are structurally unreachable: even if a
 * raw Prisma model (hash included) is passed in, only the whitelisted keys are
 * read, so they cannot serialize into a response.
 */

export interface PublicClinic {
  id: string;
  name: string;
  address: string | null;
  contactNumber: string | null;
}

export interface PublicDoctor {
  id: string;
  name: string;
  specialization: string | null;
  consultationFee: number;
  clinicId: string;
  clinic?: PublicClinic;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

// Loose input types: callers may hand us a full model — we read only safe keys.
type ClinicLike = {
  id: string;
  name: string;
  address?: string | null;
  contactNumber?: string | null;
};
type DoctorLike = {
  id: string;
  name: string;
  specialization?: string | null;
  consultationFee: number;
  clinicId: string;
  clinic?: ClinicLike | null;
};

export function toPublicClinic(c: ClinicLike): PublicClinic {
  return {
    id: c.id,
    name: c.name,
    address: c.address ?? null,
    contactNumber: c.contactNumber ?? null,
  };
}

export function toPublicDoctor(d: DoctorLike): PublicDoctor {
  const out: PublicDoctor = {
    id: d.id,
    name: d.name,
    specialization: d.specialization ?? null,
    consultationFee: d.consultationFee,
    clinicId: d.clinicId,
  };
  if (d.clinic) out.clinic = toPublicClinic(d.clinic);
  return out;
}
