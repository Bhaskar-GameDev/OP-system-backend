/**
 * Specialty matching for voice callers.
 *
 * The voice agent passes whatever specialty the caller said, transcribed by STT.
 * That string almost never equals `Doctor.specialization` exactly:
 *
 *   - it arrives in the caller's script — "చర్మ వైద్యం" for Dermatology;
 *   - STT renders an English term phonetically — "థర్మాటోలజీ", "thermatology";
 *   - callers say the body part, not the specialty — "గుండె" (heart), "skin doctor";
 *   - the stored specialization itself may be typo'd (the seed has "dermatolgy").
 *
 * A plain `specialization.includes(query)` misses all of those, and the caller is
 * told the specialty is unavailable while that doctor sits idle. This resolves both
 * sides to a canonical key via an alias table, then falls back to edit distance for
 * misspellings the table does not list.
 */

/** Canonical specialty → aliases (English, Telugu, Hindi, common STT renderings). */
const ALIASES: Record<string, string[]> = {
  'general medicine': [
    'general medicine',
    'general physician',
    'general',
    'physician',
    'medicine',
    'gp',
    'జనరల్ మెడిసిన్',
    'జనరల్',
    'సాధారణ వైద్యం',
    'ఫిజిషియన్',
    'सामान्य चिकित्सा',
    'सामान्य',
    'फिजिशियन',
  ],
  dermatology: [
    'dermatology',
    'dermatologist',
    'derma',
    'skin',
    'skin doctor',
    'డెర్మటాలజీ',
    'థర్మాటోలజీ',
    'చర్మ వైద్యం',
    'చర్మ',
    'చర్మవ్యాధి',
    'త్వచ',
    'डर्मेटोलॉजी',
    'त्वचा',
    'चर्म',
  ],
  ent: [
    'ent',
    'e n t',
    'ear nose throat',
    'otolaryngology',
    'ear',
    'nose',
    'throat',
    'ఇఎన్టి',
    'ఈఎన్టీ',
    'చెవి ముక్కు గొంతు',
    'చెవి',
    'ముక్కు',
    'గొంతు',
    'ईएनटी',
    'कान नाक गला',
    'कान',
    'गला',
  ],
  pediatrics: [
    'pediatrics',
    'paediatrics',
    'pediatric',
    'pediatrician',
    'child',
    'children',
    'kids',
    'baby',
    'పిడియాట్రిక్స్',
    'పీడియాట్రిక్స్',
    'పిల్లల డాక్టర్',
    'పిల్లల',
    'బాలల',
    'पीडियाट्रिक्स',
    'बच्चों',
    'शिशु',
  ],
  cardiology: [
    'cardiology',
    'cardiologist',
    'cardiac',
    'heart',
    'కార్డియాలజీ',
    'గుండె',
    'हृदय',
    'कार्डियोलॉजी',
    'दिल',
  ],
  orthopedics: [
    'orthopedics',
    'orthopaedics',
    'orthopedic',
    'ortho',
    'bone',
    'joint',
    'ఆర్థోపెడిక్స్',
    'ఎముకల',
    'ఎముక',
    'కీళ్ల',
    'ऑर्थोपेडिक्स',
    'हड्डी',
  ],
  gynecology: [
    'gynecology',
    'gynaecology',
    'gynecologist',
    'obstetrics',
    'women',
    'pregnancy',
    'గైనకాలజీ',
    'స్త్రీ వైద్యం',
    'గర్భం',
    'स्त्री रोग',
    'गायनेकोलॉजी',
    'महिला',
  ],
  ophthalmology: [
    'ophthalmology',
    'ophthalmologist',
    'optometry',
    'eye',
    'vision',
    'ఆప్తమాలజీ',
    'కంటి',
    'కళ్ల',
    'नेत्र',
    'आंख',
  ],
  neurology: [
    'neurology',
    'neurologist',
    'nerve',
    'brain',
    'న్యూరాలజీ',
    'నరాల',
    'మెదడు',
    'न्यूरोलॉजी',
    'तंत्रिका',
    'मस्तिष्क',
  ],
  dentistry: [
    'dentistry',
    'dental',
    'dentist',
    'teeth',
    'tooth',
    'డెంటల్',
    'దంత',
    'పంటి',
    'दंत',
    'दांत',
  ],
};

/** Lowercase, drop punctuation/underscores, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_\-.,/()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * True when the two terms are the same word give or take typos. The budget scales
 * with length so "ent" needs an exact match (a 1-edit budget there would collide
 * with "eye"), while "dermatolgy" still reaches "dermatology".
 */
function nearlyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const len = Math.max(a.length, b.length);
  if (len < 5) return false;
  const budget = len <= 7 ? 1 : Math.floor(len * 0.25);
  return levenshtein(a, b) <= budget;
}

/** Canonical keys a normalized phrase resolves to (usually 0 or 1). */
function canonicalKeys(normalized: string): Set<string> {
  const keys = new Set<string>();
  if (!normalized) return keys;
  const words = normalized.split(' ');

  for (const [key, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      if (normalized.includes(alias) || alias.includes(normalized)) {
        keys.add(key);
        break;
      }
      // Word-level fuzzy: catches "thermatology"/"dermatolgy" against "dermatology"
      // without letting a whole sentence fuzzy-match a short alias.
      if (words.some((w) => nearlyEqual(w, alias))) {
        keys.add(key);
        break;
      }
    }
  }
  return keys;
}

/**
 * Does `specialization` (as stored on the doctor) satisfy what the caller asked for?
 * An empty/absent query matches everything, matching the previous filter semantics.
 */
export function matchesSpecialty(
  specialization: string | null | undefined,
  query: string | null | undefined,
): boolean {
  const q = normalize(query ?? '');
  if (!q) return true;

  const s = normalize(specialization ?? '');
  if (!s) return false;

  if (s.includes(q) || q.includes(s)) return true;

  const sKeys = canonicalKeys(s);
  const qKeys = canonicalKeys(q);
  for (const k of qKeys) if (sKeys.has(k)) return true;

  // Last resort: the stored value and the query are the same misspelled word.
  return s.split(' ').some((sw) => q.split(' ').some((qw) => nearlyEqual(sw, qw)));
}
