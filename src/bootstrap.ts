import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { SafeExceptionFilter } from './common/http';
import { Config } from './common/config';

export async function createApp() {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
    abortOnError: false,
  });
  const config = app.get(Config);
  app.enableCors({
    origin: config.values.CORS_ORIGINS,
    exposedHeaders: ['Retry-After', 'X-RateLimit-Source'],
  });
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Bounded process-local admission; the reverse proxy supplies shared/perimeter limits.
  const rates = new Map<string, { count: number; reset: number }>();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    if (rates.size > 10000) {
      for (const [id, v] of rates) if (v.reset < now) rates.delete(id);
    }
    const current = rates.get(key);
    if (!current || current.reset < now) {
      if (rates.size >= 10000 && !current) {
        res.status(429).json({ code: 'RATE_LIMITED' });
        return;
      }
      rates.set(key, { count: 1, reset: now + 60000 });
    } else {
      current.count++;
      if (current.count > 120) {
        res.status(429).json({ code: 'RATE_LIMITED' });
        return;
      }
    }
    next();
  });
  app.use(json({ limit: '32kb', strict: true }));
  app.useGlobalFilters(new SafeExceptionFilter());
  if (config.values.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('MoneyLens').setVersion('1.0.0').addBearerAuth().build(),
    );
    SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });
  }
  app.enableShutdownHooks();
  return app;
}
