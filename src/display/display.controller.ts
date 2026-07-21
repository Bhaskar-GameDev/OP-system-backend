import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { DisplayBoard, DisplayService } from './display.service';

/** The static board page, copied next to the compiled controller at build time. */
const PAGE = join(__dirname, 'public', 'index.html');

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
  async html(@Param('clinicId') clinicId: string): Promise<string> {
    await this.display.assertClinic(clinicId);
    if (this.page === undefined) {
      if (!existsSync(PAGE)) {
        throw new NotFoundException('display page asset is missing from the build');
      }
      this.page = readFileSync(PAGE, 'utf8');
    }
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
