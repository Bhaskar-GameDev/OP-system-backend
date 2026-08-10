import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { validateProductionConfig } from './common/config/production-config.validator';
import { parseCorsOrigins } from './common/config/cors-origins';
import { httpSecurityMiddleware } from './common/security/http-security';
import { createLogger } from './common/observability/json-logger';
import { RedisIoAdapter } from './queue-engine/redis-io.adapter';

async function bootstrap(): Promise<void> {
  // FAIL CLOSED. Runs before the Nest container exists, so a production process
  // missing a secret never opens a database connection or binds a port — it
  // exits. Outside production this is a no-op and the dev fallbacks stand.
  validateProductionConfig(process.env);

  // rawBody: true preserves the raw request buffer for Razorpay webhook
  // signature verification (must hash the exact bytes Razorpay signed).
  // Production emits one JSON object per log line, each carrying the request id
  // from the surrounding request context; development keeps Nest's readable
  // output. See common/observability/json-logger.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: createLogger(),
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Catches everything a controller/service throws that isn't an HttpException,
  // so no Prisma/driver internals ever reach a client as a raw 500 body.
  app.useGlobalFilters(new AllExceptionsFilter());

  app.use(httpSecurityMiddleware());

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);

  // The login brute-force throttle counts per client IP. Behind Caddy every
  // request would otherwise carry the proxy's address, collapsing all clients
  // into one bucket — which both breaks the control and lets one busy hospital
  // throttle everyone. Trust exactly one proxy hop (our own Caddy), not an
  // arbitrary X-Forwarded-For chain a client could forge.
  // (typed loosely: @types/express is not a dependency, so the express instance
  // is reached through the platform-agnostic accessor.)
  (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set(
    'trust proxy',
    1,
  );

  // CORS: every client (Tauri reception app, web preview/testing, future RN
  // patient app) otherwise hits a missing-CORS wall. Configure the real allowed
  // origins via CORS_ORIGINS (comma-separated). Defaults cover local dev only.
  const corsOrigins = parseCorsOrigins(config.get<string>('CORS_ORIGINS'));
  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // Realtime fan-out through Redis rather than process memory. Installed even
  // on a single instance: adding a replica later must not silently break the
  // dashboards connected to the other one.
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connect();
  app.useWebSocketAdapter(ioAdapter);

  // Shut down cleanly on SIGTERM/SIGINT so Nest runs onModuleDestroy hooks —
  // Prisma disconnects and Redis clients close instead of being severed
  // mid-write when the container is rolled.
  app.enableShutdownHooks();

  await app.listen(port);
  Logger.log(`Patient Flow OS backend listening on :${port}`, 'Bootstrap');
}

// A rejection with no .catch() anywhere would otherwise terminate the process on
// modern Node, taking every in-flight request with it. Log it and keep serving;
// the HTTP layer already answers each request through the global filter.
process.on('unhandledRejection', (reason) => {
  Logger.error(`unhandled rejection: ${String(reason)}`, undefined, 'Process');
});

// An uncaught exception leaves the process in an unknown state, so the safe
// move is to log it and exit — the orchestrator restarts us, and the load
// balancer drains. Do NOT swallow it and continue serving from a broken state.
process.on('uncaughtException', (err) => {
  Logger.error(`uncaught exception: ${err.message}`, err.stack, 'Process');
  process.exit(1);
});

void bootstrap().catch((err: Error) => {
  // A failure here (bad DATABASE_URL, port in use) must be loud and must exit
  // non-zero, or the container reports healthy while serving nothing.
  Logger.error(`bootstrap failed: ${err.message}`, err.stack, 'Bootstrap');
  process.exit(1);
});
