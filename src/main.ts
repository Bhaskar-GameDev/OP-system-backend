import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // rawBody: true preserves the raw request buffer for Razorpay webhook
  // signature verification (must hash the exact bytes Razorpay signed).
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);

  // CORS: every client (Tauri reception app, web preview/testing, future RN
  // patient app) otherwise hits a missing-CORS wall. Configure the real allowed
  // origins via CORS_ORIGINS (comma-separated). Defaults cover local dev only.
  const corsOrigins = (
    config.get<string>('CORS_ORIGINS') ??
    'http://localhost:1420,http://tauri.localhost,https://tauri.localhost'
  )
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  await app.listen(port);
  Logger.log(`Patient Flow OS backend listening on :${port}`, 'Bootstrap');
}

void bootstrap();
