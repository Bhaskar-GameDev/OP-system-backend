import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import { DisplayBoard, DisplayService } from './display.service';

/** The static board page, copied next to the compiled controller at build time. */
const PAGE = join(__dirname, 'public', 'index.html');

/**
 * The only part of the response object this controller touches. Typed
 * structurally because @types/express is not a dependency.
 */
interface HeaderSink {
  setHeader(name: string, value: string): void;
}

/**
 * Build the board page's Content-Security-Policy from the page itself.
 *
 * The page carries one inline <style> and one inline <script>, so a policy of
 * `'self'` alone would break it and `'unsafe-inline'` would defeat the point —
 * this page renders doctor names and token numbers that come from the database.
 * Hashing the exact inline blocks permits precisely those two and nothing else:
 * an injected script has a different hash and does not run.
 */
function contentSecurityPolicyFor(page: string): string {
  const scripts = inlineHashes(page, 'script');
  const styles = inlineHashes(page, 'style');
  return [
    "default-src 'none'",
    // socket.io's client bundle is served by this same origin.
    `script-src 'self' ${scripts.join(' ')}`.trim(),
    `style-src ${styles.join(' ')}`.trim(),
    // REST poll + the Socket.io feed, both same-origin.
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function inlineHashes(page: string, tag: 'script' | 'style'): string[] {
  // Only blocks with no attributes carry inline content here; a <script src=…>
  // has nothing to hash and is covered by 'self'.
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const hashes: string[] = [];
  for (const [, body] of page.matchAll(pattern)) {
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/**
 * Waiting-room TV board — deliberately PUBLIC, no auth guard.
 *
 * A wall-mounted screen cannot log in, and the board is designed so that it does
 * not need to: it exposes doctor names, specialities, token numbers and waiting
 * counts, all of which a patient already sees before booking. No patient
 * identity, booking or payment data is reachable through these routes (see the
 * privacy note on DisplayDoctorCard).
 *
 * The clinicId in the URL is therefore treated as public, not as a secret. It
 * confers no ability to read or mutate anything a passer-by could not already
 * see by standing in the waiting room — so a secret URL token would add key
 * distribution and rotation work without protecting anything.
 */
@Controller('display')
export class DisplayController {
  /** Read once: the asset is immutable for the life of the process. */
  private page?: string;
  /** Derived from the page's own inline blocks, so it is computed once too. */
  private csp?: string;

  constructor(private readonly display: DisplayService) {}

  /**
   * The board page itself. Serves the same static HTML for every clinic; the
   * page reads the clinic id back out of its own URL. The clinic is validated
   * here so an unknown id returns 404 rather than a page that renders forever
   * empty.
   */
  @Get(':clinicId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async html(
    @Param('clinicId') clinicId: string,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<string> {
    await this.display.assertClinic(clinicId);
    if (this.page === undefined) {
      if (!existsSync(PAGE)) {
        throw new NotFoundException('display page asset is missing from the build');
      }
      this.page = readFileSync(PAGE, 'utf8');
      this.csp = contentSecurityPolicyFor(this.page);
    }
    // Replaces the API-wide policy from helmet, which forbids loading anything
    // at all — correct for JSON, wrong for the one page this server renders.
    res.setHeader('Content-Security-Policy', this.csp!);
    return this.page;
  }

  /**
   * Board state as JSON. The page fetches this on load, on reconnect, and on a
   * slow poll — the socket feed carries live deltas, this carries the structure
   * (a doctor starting a session mid-day never produces a queue event).
   */
  @Get(':clinicId/state')
  @Header('Cache-Control', 'no-store')
  state(@Param('clinicId') clinicId: string): Promise<DisplayBoard> {
    return this.display.board(clinicId);
  }
}
