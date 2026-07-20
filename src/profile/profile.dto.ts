import { Gender } from '@prisma/client';

/** Patient profile as returned to the owning patient. */
export interface ProfileView {
  id: string;
  name: string;
  mobile: string;
  age: number | null;
  gender: Gender | null;
}

/** Editable profile fields. name is required; age/gender optional. */
export interface UpdateProfileInput {
  name?: string;
  age?: number | null;
  gender?: Gender | null;
}

type PatientRow = {
  id: string;
  name: string;
  mobile: string;
  age: number | null;
  gender: Gender | null;
};

export function toProfileView(p: PatientRow): ProfileView {
  return {
    id: p.id,
    name: p.name,
    mobile: p.mobile,
    age: p.age,
    gender: p.gender,
  };
}

export const GENDERS: Gender[] = [Gender.MALE, Gender.FEMALE, Gender.OTHER];
