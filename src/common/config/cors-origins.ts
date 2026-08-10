/**
 * Local-development origins. These are the Tauri dev-server and packaged-app
 * origins; they are NOT a production allowlist, which is why deployments set
 * CORS_ORIGINS explicitly.
 */
export const DEFAULT_CORS_ORIGINS = [
  'http://localhost:1420',
  'http://tauri.localhost',
  'https://tauri.localhost',
];

/**
 * Parse the comma-separated CORS_ORIGINS setting into an allowlist.
 *
 * Shared by the HTTP layer (main.ts) and the Socket.io gateway on purpose. They
 * used to disagree: HTTP enforced this list while the gateway declared
 * `origin: '*'`, so the realtime surface — which streams a clinic's entire live
 * queue — accepted connections from any web page, including an attacker's.
 * One parser means one answer for both.
 */
export function parseCorsOrigins(raw?: string | null): string[] {
  const configured = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return configured.length > 0 ? configured : [...DEFAULT_CORS_ORIGINS];
}
