/**
 * Contract for POST /setup/hospital. Plain interfaces, not a validated class:
 * the global ValidationPipe runs with `whitelist: true`, which strips every
 * property of a DTO class that carries no class-validator decorator, so an
 * undecorated class would arrive empty. The sibling unauthenticated routes in
 * auth.controller.ts take the same approach and validate in the service.
 */
export interface HospitalSetupInput {
  /** Must match HOSPITAL_SETUP_KEY; the route is disabled when that is unset. */
  setupKey?: string;
  hospital?: string;
  /**
   * Name for the first clinic. Optional — a single-site hospital would only
   * retype its own name here, so when omitted the clinic takes the hospital's
   * name. Further clinics are created from the Admin tab, where the name matters.
   */
  clinic?: string;
  /** Required: a clinic with no address or number cannot be contacted or found. */
  address?: string;
  contactNumber?: string;
  adminUsername?: string;
  adminName?: string;
  adminPassword?: string;
}

/**
 * Deliberately returns NO session token. Creating the tenant and signing into it
 * stay separate steps, so this route never becomes a way to obtain credentials
 * for a hospital that already exists.
 */
export interface HospitalSetupResult {
  hospitalId: string;
  hospitalName: string;
  clinicId: string;
  clinicName: string;
  adminUsername: string;
}

/** Whether the desk should offer the setup flow at all. */
export interface HospitalSetupStatus {
  enabled: boolean;
}
