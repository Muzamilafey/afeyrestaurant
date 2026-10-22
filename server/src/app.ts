import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env, isTest } from './config/env';
import { logger } from './lib/logger';
import { requestId, sanitizeInput, errorHandler } from './middleware/common';
import { resolveHostTenant } from './middleware/tenantHost';
import { buildOpenApi } from './http/openapi';
import { healthRouter } from './modules/health/routes';
import auth from './modules/auth/routes';
import platform from './modules/platform/routes';
import admin from './modules/admin/routes';
import menu from './modules/menu/routes';
import tables from './modules/tables/routes';
import orders from './modules/orders/routes';
import kitchen from './modules/kitchen/routes';
import inventory from './modules/inventory/routes';
import cash from './modules/cash/routes';
import mpesa from './modules/mpesa/routes';
import integrations from './modules/integrations/routes';
import staff, { bridgeModule } from './modules/attendance/routes';
import crm, { publicModule } from './modules/customers/routes';
import reports from './modules/reports/routes';
import sync from './modules/sync/routes';
import { AppError } from './lib/errors';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(requestId);
  if (!isTest) app.use(pinoHttp({ logger, genReqId: (req) => (req as express.Request).id, autoLogging: { ignore: (req) => req.url === '/api/v1/health' } }));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    cors({
      credentials: true,
      origin: (origin, cb) => {
        // Allow same-origin/non-browser requests, the configured origins and tenant subdomains of ROOT_DOMAIN.
        if (!origin) return cb(null, true);
        try {
          const host = new URL(origin).hostname;
          if (origins.includes(origin) || (env.ROOT_DOMAIN !== 'localhost' && host.endsWith(`.${env.ROOT_DOMAIN}`))) return cb(null, true);
        } catch {
          /* fallthrough */
        }
        cb(new AppError(403, 'CORS', 'Origin not allowed'));
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(sanitizeInput);
  app.use('/api', rateLimit({ windowMs: 60_000, limit: isTest ? 100000 : 600, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } } }));
  app.use(resolveHostTenant);

  app.use('/api/v1', healthRouter);
  for (const mod of [auth, platform, admin, menu, tables, orders, kitchen, inventory, cash, mpesa, integrations, staff, bridgeModule, crm, publicModule, reports, sync]) {
    app.use(`/api/v1${mod.basePath}`, mod.router);
  }
  const spec = buildOpenApi();
  app.get('/api/v1/openapi.json', (_req, res) => res.json(spec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Chili POS API' }));
  // Product images only (validated on upload). No directory listing; no other files are served from here.
  app.use('/uploads', express.static(path.resolve(env.UPLOAD_DIR), { index: false, dotfiles: 'deny', maxAge: '7d', fallthrough: false }));
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found')));
  app.use(errorHandler);
  return app;
}
