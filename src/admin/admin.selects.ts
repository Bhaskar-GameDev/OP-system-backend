/**
 * The exact columns admin endpoints read.
 *
 * Every one of these is a privacy decision as much as a query: the admin surface
 * must not accidentally ship a password hash or a patient's mobile because a
 * `select` was widened for one screen. They were inline at the top of
 * `admin.service.ts` (535 lines); keeping them together makes the whole exposed
 * surface readable at once. Unchanged otherwise.
 */
import { Prisma } from '@prisma/client';

export const CLINIC_SELECT = {
  id: true,
  name: true,
  address: true,
  contactNumber: true,
} satisfies Prisma.ClinicSelect;

export const DOCTOR_SELECT = {
  id: true,
  clinicId: true,
  name: true,
  specialization: true,
  consultationFee: true,
  avgConsultMinutes: true,
  photoUrl: true,
  username: true,
  // Both feed admin-only flags (canSignIn / sessionCount) so a half-configured
  // doctor is visible on the admin screen rather than discovered by a patient.
  // `toAdminDoctor` reduces the hash to a boolean — it is never sent to a client.
  passwordHash: true,
  _count: { select: { sessions: true } },
} satisfies Prisma.DoctorSelect;

export const SESSION_SELECT = {
  id: true,
  doctorId: true,
  sessionType: true,
  startTime: true,
  maxTokens: true,
  daysOfWeek: true,
} satisfies Prisma.DoctorSessionSelect;

export const STAFF_SELECT = {
  id: true,
  clinicId: true,
  name: true,
  role: true,
  username: true,
} satisfies Prisma.StaffSelect;

/**
 * Admin Portal CRUD. EVERY method is scoped to the caller's own clinicId, which
 * the controller derives from the authenticated admin's JWT — never from a
 * request parameter. A clinicId in a request body is only ever used to CONFIRM
 * it matches the token (assertClinic); a mismatch is 403, never a scope switch.
 *
 * For edit/delete of an existing doctor/staff row, scope is re-checked against
 * the LOADED row's clinicId: an admin from Clinic A passing Clinic B's real
 * doctor id gets 403, because that doctor's clinicId != the token's clinicId.
 *
 * No clinic-creation endpoint exists — onboarding is a seed script. Clinic
 * management is edit-only, scoped to the admin's own clinic.
 */
