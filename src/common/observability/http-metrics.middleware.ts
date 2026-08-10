import { Injectable, NestMiddleware } from '@nestjs/common';
import { MetricsService } from './metrics.service';

interface RequestLike {
  method?: string;
  originalUrl?: string;
  url?: string;
  route?: { path?: string };
  baseUrl?: string;
}
interface ResponseLike {
  statusCode: number;
  on(event: 'finish' | 'close', listener: () => void): void;
}

/**
 * Records latency and status for every HTTP request.
 *
 * Timed on `finish`, so the measurement covers the whole response including the
 * exception filter — a request that 500s is exactly the one whose duration and
 * status must be recorded.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: RequestLike, res: ResponseLike, next: () => void): void {
    const stop = this.metrics.httpDuration.startTimer();
    let recorded = false;
    const record = (): void => {
      if (recorded) return; // 'finish' and 'close' can both fire
      recorded = true;
      stop({
        method: req.method ?? 'UNKNOWN',
        route: routeLabel(req),
        status: String(res.statusCode),
      });
    };
    res.on('finish', record);
    res.on('close', record);
    next();
  }
}

/**
 * A bounded label for the request's route.
 *
 * Express fills `req.route.path` only after routing, which has not happened yet
 * when the middleware runs — but the listener fires at `finish`, by which time
 * it is set. That gives the declared pattern (`/bookings/:id/cancel`) rather
 * than the concrete URL.
 *
 * The fallback matters more than it looks: labelling by raw URL would create a
 * new time series per booking id, per patient, per token — unbounded
 * cardinality that eventually takes Prometheus down, and a metrics endpoint
 * that leaks identifiers. So anything that looks like an id is replaced.
 */
export function routeLabel(req: RequestLike): string {
  if (req.route?.path) return `${req.baseUrl ?? ''}${req.route.path}` || req.route.path;
  return normalisePath((req.originalUrl ?? req.url ?? '/').split('?')[0]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalisePath(path: string): string {
  const parts = path.split('/').map((segment) => {
    if (!segment) return segment;
    if (UUID.test(segment)) return ':id';
    if (/^\d+$/.test(segment)) return ':id';
    // Mixed-case opaque ids (cuid, nanoid, our seeded ids) — anything long
    // enough to be an identifier rather than a path word.
    if (segment.length >= 16 && /\d/.test(segment)) return ':id';
    return segment;
  });
  const normalised = parts.join('/');
  return normalised.length > 0 ? normalised : '/';
}
