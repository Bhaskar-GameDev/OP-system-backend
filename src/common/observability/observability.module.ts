import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Observability: correlation ids, structured logs, metrics, health.
 *
 * Global because the metrics recorder has to be reachable from anywhere that
 * knows something worth counting — the auth service, the gateway, the queue —
 * without every module importing this one.
 */
@Global()
@Module({
  controllers: [MetricsController, HealthController],
  providers: [MetricsService, HttpMetricsMiddleware],
  exports: [MetricsService],
})
export class ObservabilityModule {}
