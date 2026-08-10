import helmet from 'helmet';

/**
 * Security headers for every HTTP response.
 *
 * Kept out of `main.ts` so the test suite applies the *same* configuration the
 * production process does — a header policy that is only exercised by hand is a
 * policy nobody notices losing.
 *
 * The API answers JSON, so the default CSP is the strictest one that still
 * describes it honestly: nothing may be loaded from an API response, it may not
 * be framed, and it may not be MIME-sniffed. The one HTML page this server
 * serves — the waiting-room board — replaces the CSP header with its own,
 * hash-based policy in DisplayController.
 */
export function httpSecurityMiddleware(): ReturnType<typeof helmet> {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // HSTS is also set at the edge (Caddyfile). Kept here so a deployment that
    // ever terminates TLS somewhere else does not silently lose it.
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    // Deliberately off: every client is cross-origin (Tauri desktop apps, the
    // RN patient app, a browser preview), and these would block exactly the
    // cross-origin reads the CORS allowlist is there to permit.
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  });
}
