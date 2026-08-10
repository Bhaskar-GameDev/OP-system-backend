import { Controller, Get, Header, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

interface DependencyStatus {
  status: 'up' | 'down';
  /** Round-trip in milliseconds — a slow dependency is a failing one, later. */
  latencyMs?: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  dependencies: Record<string, DependencyStatus>;
}

/**
 * Liveness and readiness.
 *
 * The Compose healthcheck used to treat ANY HTTP response — including 401 and
 * 404 — as healthy, so it verified that Node was listening and nothing else. A
 * backend whose Postgres connection had died reported healthy and kept serving
 * 503s to the clinic.
 *
 * Two endpoints, because they answer different questions:
 *
 *  - `/health` — is this process alive? No dependency calls, so a database
 *    outage never causes the orchestrator to kill and restart an otherwise
 *    healthy process (a restart loop makes an outage worse, not better).
 *  - `/health/ready` — can it actually serve? Checks Postgres and Redis and
 *    reports 503 when either is unreachable. This is what the healthcheck and
 *    any load balancer should use.
 *
 * Both are unauthenticated and deliberately expose nothing beyond up/down,
 * latency and uptime — no versions, no hostnames, no configuration.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(): Promise<ReadinessReport> {
    const [postgres, redis] = await Promise.all([
      probe(() => this.prisma.$queryRaw`SELECT 1`),
      probe(() => this.redis.redis.ping()),
    ]);

    const report: ReadinessReport = {
      status: postgres.status === 'up' && redis.status === 'up' ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      dependencies: { postgres, redis },
    };

    // Thrown as an HttpException carrying the report as its body, so a 503 still
    // says WHICH dependency is down — an operator reading it needs that first
    // line, not just the code.
    if (report.status === 'degraded') {
      throw new HttpException(report, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }
}

async function probe(fn: () => Promise<unknown>): Promise<DependencyStatus> {
  const start = Date.now();
  try {
    await fn();
    return { status: 'up', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      // The driver message names the host and sometimes the credentials shape;
      // only the error type is safe to hand back on an unauthenticated route.
      error: err instanceof Error ? err.name : 'unknown error',
    };
  }
}
