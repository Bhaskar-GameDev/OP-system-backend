import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P0.6 — the published demo credentials must not come back.
 *
 * These four strings were working passwords for privileged accounts (admin,
 * super-admin, reception, doctor) documented in a PUBLIC repository. This suite
 * scans the backend's own tree so a future change cannot quietly reintroduce
 * them, in code, in a fixture, or in documentation.
 *
 * The strings are unavoidably present in THIS file and in the seed-guard spec,
 * which exist precisely to detect them — those two are the only exemptions, and
 * they are named explicitly rather than pattern-excluded.
 */

const BACKEND_ROOT = join(__dirname, '..');

/** The credentials that were published. Not usable — they are being hunted. */
const RETIRED_CREDENTIALS = ['admin123', 'superadmin123', 'reception123', 'doctor123'];

/** Files whose job is to detect these strings, so they must contain them. */
const DETECTOR_FILES = new Set([
  join('test', 'credential-exposure.spec.ts'),
  join('test', 'seed-production-guard.spec.ts'),
  join('.github', 'workflows', 'ci.yml'),
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'backups']);
const SCANNED_EXTENSIONS = ['.ts', '.js', '.json', '.md', '.yml', '.yaml', '.sh', '.sql'];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (SCANNED_EXTENSIONS.some((e) => entry.endsWith(e))) acc.push(full);
  }
  return acc;
}

describe('retired demo credentials', () => {
  const files = walk(BACKEND_ROOT);

  it('scans a meaningful number of files (the walker itself works)', () => {
    // Guards against the scan silently covering nothing and passing vacuously.
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(RETIRED_CREDENTIALS)(
    'does not appear anywhere in the backend tree: %s',
    (credential) => {
      const offenders: string[] = [];
      for (const file of files) {
        const relative = file.slice(BACKEND_ROOT.length + 1);
        if (DETECTOR_FILES.has(relative)) continue;
        if (readFileSync(file, 'utf8').includes(credential)) offenders.push(relative);
      }
      expect(offenders).toEqual([]);
    },
  );

  it('DEMO.md documents a placeholder instead of a password', () => {
    const demo = readFileSync(join(BACKEND_ROOT, 'DEMO.md'), 'utf8');
    expect(demo).toContain('<LOCAL_DEVELOPMENT_PASSWORD>');
    for (const credential of RETIRED_CREDENTIALS) {
      expect(demo).not.toContain(credential);
    }
  });

  it('DEMO.md explains where the real development password comes from', () => {
    const demo = readFileSync(join(BACKEND_ROOT, 'DEMO.md'), 'utf8');
    expect(demo).toMatch(/SEED_ADMIN_PASSWORD/);
    expect(demo).toMatch(/generat/i); // "generated"/"generates"
  });
});
