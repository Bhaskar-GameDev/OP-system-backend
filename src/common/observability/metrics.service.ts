import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * The metrics this service exposes, and why each one exists.
 *
 * The system had none: production problems were discovered by users, and
 * questions like "when did the error rate rise", "which endpoint is slow" and
 * "are notifications failing" had no answer at all. Each metric below maps to a
 * question an operator will actually ask during an incident — nothing is
 * collected because it was easy to collect.
 *
 * Cardinality is kept deliberately low. Labels are method, a NORMALISED route
 * (ids replaced with `:id`, see http-metrics.middleware) and status class —
 * never a raw URL, never a patient, clinic or token id. A metric keyed by
 * patient would both explode the series count and turn the metrics endpoint
 * into a patient register.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** Latency and, by its `_count`, request and error rate per route. */
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;

  /** Failed authentications, split by which surface was attacked. */
  readonly authFailures: Counter<'scope' | 'reason'>;

  /** Rejected logins that never reached bcrypt because the throttle fired. */
  readonly loginThrottled: Counter<'scope'>;

  /**
   * Events appended but not yet applied to the read models.
   *
   * Not derivable from HTTP metrics: a stalled projection returns 200s while
   * every dashboard silently shows the past. Rising lag is the only signal.
   */
  readonly projectionLag: Gauge;

  /** Projection passes that threw — a stalled projection is a silent failure. */
  readonly projectionFailures: Counter;

  /** Live authenticated sockets, by role. Drops to zero = realtime is down. */
  readonly socketConnections: Gauge<'role'>;

  /** Outbound provider calls (MSG91 / Razorpay / FCM) by outcome. */
  readonly integrationCalls: Counter<'provider' | 'outcome'>;

  constructor() {
    // Process-level series: heap, event-loop lag, GC, open handles. These are
    // what distinguish "the app is slow" from "the host is slow".
    collectDefaultMetrics({ register: this.registry, prefix: 'pfos_' });

    this.httpDuration = new Histogram({
      name: 'pfos_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      // Tuned to this app: most calls are a couple of Redis/Postgres round
      // trips, so the interesting detail is below a second.
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.authFailures = new Counter({
      name: 'pfos_auth_failures_total',
      help: 'Failed authentication attempts',
      labelNames: ['scope', 'reason'],
      registers: [this.registry],
    });

    this.loginThrottled = new Counter({
      name: 'pfos_login_throttled_total',
      help: 'Login attempts rejected by the brute-force throttle',
      labelNames: ['scope'],
      registers: [this.registry],
    });

    this.projectionLag = new Gauge({
      name: 'pfos_projection_lag_events',
      help: 'Events appended to the store but not yet applied to the read models',
      registers: [this.registry],
    });

    this.projectionFailures = new Counter({
      name: 'pfos_projection_failures_total',
      help: 'Projection passes that threw',
      registers: [this.registry],
    });

    this.socketConnections = new Gauge({
      name: 'pfos_socket_connections',
      help: 'Currently connected authenticated realtime clients',
      labelNames: ['role'],
      registers: [this.registry],
    });

    this.integrationCalls = new Counter({
      name: 'pfos_integration_calls_total',
      help: 'Outbound calls to external providers by outcome',
      labelNames: ['provider', 'outcome'],
      registers: [this.registry],
    });
  }

  /** Prometheus exposition text for the scrape endpoint. */
  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
