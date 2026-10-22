import type { Request, Response, NextFunction } from 'express';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { Tenant } from '../models';

const cache = new Map<string, { at: number; id: Types.ObjectId | null }>();
const RESERVED = new Set(['www', 'api', 'app', 'admin', 'platform', 'static', 'mail']);

/**
 * Resolve the tenant from a trusted hostname: <slug>.<ROOT_DOMAIN> or a registered custom domain.
 * The result is advisory — authentication still verifies the user belongs to that tenant.
 * Host headers are only trusted behind our own reverse proxy (see TRUST_PROXY / Nginx config).
 */
export async function resolveHostTenant(req: Request, _res: Response, next: NextFunction) {
  try {
    const host = (req.hostname || '').toLowerCase();
    req.hostTenantId = null;
    if (!host || host === env.ROOT_DOMAIN || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return next();
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < 60_000) {
      req.hostTenantId = hit.id;
      return next();
    }
    let id: Types.ObjectId | null = null;
    const suffix = `.${env.ROOT_DOMAIN}`;
    if (host.endsWith(suffix)) {
      const slug = host.slice(0, -suffix.length);
      if (!slug.includes('.') && !RESERVED.has(slug)) id = (await Tenant.findOne({ slug }, { _id: 1 }).lean())?._id ?? null;
    } else {
      id = (await Tenant.findOne({ customDomains: host }, { _id: 1 }).lean())?._id ?? null;
    }
    cache.set(host, { at: Date.now(), id });
    req.hostTenantId = id;
    next();
  } catch (e) {
    next(e);
  }
}
