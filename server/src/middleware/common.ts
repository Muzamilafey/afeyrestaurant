import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { TenantGuardError } from '../db/tenantGuard';
import { transactionsUnavailable } from '../db/connect';

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

/** Strip keys that could be interpreted as MongoDB operators ($gt, $where) or dotted paths. */
function clean(v: unknown, depth = 0): unknown {
  if (depth > 20) return undefined;
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = clean(val, depth + 1);
    }
    return out;
  }
  return v;
}
export function sanitizeInput(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') req.body = clean(req.body);
  // Express 5 exposes req.query as a getter; redefine it with a sanitised copy.
  const q = clean(req.query);
  Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true, enumerable: true });
  next();
}

/** Driver errors meaning the database cannot be reached right now (as opposed to a bad request or a bug). */
const DB_UNAVAILABLE = new Set(['MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoNotConnectedError', 'MongoTopologyClosedError', 'MongoPoolClearedError']);
const isDbUnavailable = (err: { name?: string; message?: string }) =>
  DB_UNAVAILABLE.has(err?.name ?? '') || (err?.name === 'MongooseError' && /buffering timed out/.test(err.message ?? ''));
/** Code 20 / IllegalOperation: a session or transaction was used against a standalone mongod. */
const isTxnUnsupported = (err: { code?: number; message?: string }) => err?.code === 20 && /replica set member or mongos/.test(err.message ?? '');

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, reqId: req.id }, err.message);
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    return;
  }
  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Validation failed', details: Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message])), requestId: req.id } });
    return;
  }
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({ error: { code: 'BAD_ID', message: `Invalid value for ${err.path}`, requestId: req.id } });
    return;
  }
  if ((err as { code?: number }).code === 11000) {
    res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with these details already exists', details: (err as { keyValue?: unknown }).keyValue, requestId: req.id } });
    return;
  }
  if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', requestId: req.id } });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body', requestId: req.id } });
    return;
  }
  if (isTxnUnsupported(err)) {
    logger.error({ err, reqId: req.id }, 'MongoDB rejected a transaction: the server is not a replica set member');
    const e = transactionsUnavailable();
    res.status(e.status).json({ error: { code: e.code, message: e.message, requestId: req.id } });
    return;
  }
  if (isDbUnavailable(err)) {
    logger.error({ err, reqId: req.id }, 'Database unavailable');
    res.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is temporarily unavailable. Please try again shortly.', requestId: req.id } });
    return;
  }
  if (err instanceof TenantGuardError) logger.fatal({ err, reqId: req.id }, 'Tenant guard violation');
  else logger.error({ err, reqId: req.id }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId: req.id } });
};
