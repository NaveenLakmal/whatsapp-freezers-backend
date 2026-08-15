import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // ── CORS ─────────────────────────────────────────────────────────────────
  // Allow the Flutter app (any origin in dev, restrict in production).
  app.enableCors({
    origin: '*', // Update to your Flutter app's origin in production
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
    credentials: false,
  });

  // ── Global Validation Pipe ────────────────────────────────────────────────
  // Validates all incoming DTOs using class-validator decorators.
  // whitelist: true strips any properties not defined in DTOs.
  // forbidNonWhitelisted: true returns 400 if unknown properties are sent.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ── Socket.io Adapter ─────────────────────────────────────────────────────
  // Replaces the default adapter with the official Socket.io adapter.
  // Required for @nestjs/websockets to work with socket.io properly.
  app.useWebSocketAdapter(new IoAdapter(app));

  // ── Route Compatibility Middleware ───────────────────────────────────────
  // Automatically handles requests both with and without the `/api/v1` prefix
  // so the Flutter app works whether Server URL is `http://localhost:3001` or `http://localhost:3001/api/v1`.
  app.use((req: any, res: any, next: () => void) => {
    if (!req.url.startsWith('/api/v1') && !req.url.startsWith('/socket.io')) {
      req.url = '/api/v1' + req.url;
    }
    next();
  });

  // ── Global Prefix ─────────────────────────────────────────────────────────
  app.setGlobalPrefix('api/v1');

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`🚀 WhatsApp Backend running on: http://localhost:${port}/api/v1`);
  logger.log(`📡 WebSocket gateway at: ws://localhost:${port}`);
  logger.log(`📷 Scan QR code at: GET http://localhost:${port}/api/v1/connection/qr`);
}

void bootstrap();
