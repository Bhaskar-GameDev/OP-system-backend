import { matchesSpecialty } from '../src/voice/specialty-match';

/**
 * Specialty matching for voice callers. A real call on 2026-08-18 was told
 * "dermatology unavailable" because STT handed the backend "థర్మాటోలజీ" while the
 * doctor's specialization read "Dermatology" — the old filter was a plain
 * `includes`. These cases are the ones observed on live calls plus the seeded
 * typo ("dermatolgy") that the same filter also missed.
 */
describe('matchesSpecialty', () => {
  it('matches exactly and case-insensitively', () => {
    expect(matchesSpecialty('Dermatology', 'dermatology')).toBe(true);
    expect(matchesSpecialty('General Medicine', 'general medicine')).toBe(true);
  });

  it('matches the underscored form the LLM emits', () => {
    expect(matchesSpecialty('General Medicine', 'general_medicine')).toBe(true);
  });

  it('matches STT phonetic renderings that broke the live call', () => {
    expect(matchesSpecialty('Dermatology', 'థర్మాటోలజీ')).toBe(true);
    expect(matchesSpecialty('Dermatology', 'thermatology')).toBe(true);
  });

  it('matches Telugu and Hindi terms for the specialty', () => {
    expect(matchesSpecialty('Dermatology', 'చర్మ వైద్యం')).toBe(true);
    expect(matchesSpecialty('General Medicine', 'జనరల్ మెడిసిన్')).toBe(true);
    expect(matchesSpecialty('Pediatrics', 'పిల్లల డాక్టర్')).toBe(true);
    expect(matchesSpecialty('Cardiology', 'हृदय')).toBe(true);
    expect(matchesSpecialty('ENT', 'చెవి ముక్కు గొంతు')).toBe(true);
  });

  it('matches the body part a caller names instead of the specialty', () => {
    expect(matchesSpecialty('Dermatology', 'skin doctor')).toBe(true);
    expect(matchesSpecialty('Cardiology', 'heart')).toBe(true);
    expect(matchesSpecialty('Ophthalmology', 'eye')).toBe(true);
  });

  it('tolerates a typo in the stored specialization (seed has "dermatolgy")', () => {
    expect(matchesSpecialty('dermatolgy', 'dermatology')).toBe(true);
    expect(matchesSpecialty('dermatolgy', 'చర్మ వైద్యం')).toBe(true);
  });

  it('treats an empty query as "any specialty"', () => {
    expect(matchesSpecialty('ENT', '')).toBe(true);
    expect(matchesSpecialty('ENT', null)).toBe(true);
    expect(matchesSpecialty('ENT', undefined)).toBe(true);
  });

  it('does not match unrelated specialties', () => {
    expect(matchesSpecialty('Dermatology', 'cardiology')).toBe(false);
    expect(matchesSpecialty('ENT', 'eye')).toBe(false);
    expect(matchesSpecialty('Pediatrics', 'గుండె')).toBe(false);
    expect(matchesSpecialty('General Medicine', 'dermatology')).toBe(false);
  });

  it('does not match when the doctor has no specialization recorded', () => {
    expect(matchesSpecialty(null, 'dermatology')).toBe(false);
    expect(matchesSpecialty('', 'dermatology')).toBe(false);
  });
});
