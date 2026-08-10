/**
 * Minimal RFC-4180 CSV writing, shared by the export endpoints (admin reports,
 * audit log). Lines are CRLF-joined because Excel treats a bare LF file as one
 * long row on Windows, which is where these downloads are opened.
 */

/** Quote a cell only when it contains a delimiter, quote or newline. */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Header + rows as a CSV document. Every cell is quoted as needed. */
export function toCsv(header: string[], rows: string[][]): string {
  const lines = rows.map((r) => r.map(csvCell).join(','));
  return [header.join(','), ...lines].join('\r\n');
}
