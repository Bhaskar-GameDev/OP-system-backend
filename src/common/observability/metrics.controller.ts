import {
  Controller,
  Get,
  Header,
  Headers,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { isProduction } from '../config/production-config.validator';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint.
 *
 * Access posture, in order of precedence:
 *
 *  1. `METRICS_TOKEN` set — a bearer token is required. This is the intended
 *     production configuration; the scraper holds the token.
 *  2. Unset in production — the endpoint reports 404 and serves nothing.
 *     Metrics describe internal structure (route names, error rates, queue
 *     failures) and are not something to publish by accident, so an operator
 *     who has not configured access gets no endpoint rather than an open one.
 *  3. Unset outside production — open, so `curl localhost:3000/metrics` works
 *     while developing.
 *
 * The endpoint carries no patient data by construction: every label is a method,
 * a normalised route, a status code, a role or a provider name.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  // The Prometheus text exposition format. Stated literally because the header
  // must be on the response before the body is rendered.
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Headers('authorization') authorization?: string): Promise<string> {
    const expected = this.config.get<string>('METRICS_TOKEN')?.trim();

    if (!expected) {
      if (isProduction()) {
        throw new NotFoundException(); // disabled, and says nothing about why
      }
    } else {
      const presented = authorization?.startsWith('Bearer ')
        ? authorization.slice(7)
        : '';
      if (!constantTimeEquals(presented, expected)) {
        throw new UnauthorizedException('invalid metrics token');
      }
    }

    return this.metrics.render();
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
