import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Permission } from '../auth/permissions';
import { registerOperation } from './openapi';
import { authenticate, requirePermission, requireFeature, requirePlatformAdmin } from '../middleware/auth';
import type { RequestContext, TenantContext, BranchContext } from './context';
import { badRequest } from '../lib/errors';

type Auth = 'public' | 'user' | 'tenant' | 'branch' | 'platform';
type CtxFor<A extends Auth> = A extends 'branch' ? BranchContext : A extends 'tenant' ? TenantContext : A extends 'public' ? undefined : RequestContext;

interface RouteSpec<B extends z.ZodType, Q extends z.ZodType, A extends Auth> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  auth?: A;
  permission?: Permission | Permission[];
  feature?: string;
  body?: B;
  query?: Q;
  /** Return raw response (e.g. CSV / redirects) instead of JSON { data }. */
  raw?: boolean;
  status?: number;
  middleware?: Array<(req: Request, res: Response, next: NextFunction) => void>;
}

export interface Handler<B, Q, C> {
  (input: { body: B; query: Q; params: Record<string, string>; ctx: C; req: Request; res: Response }): Promise<unknown>;
}

/** Create a module router. Each route is validated, permission-checked and documented in OpenAPI. */
export function createModule(basePath: string, tag: string) {
  const router = Router();
  function route<B extends z.ZodType = z.ZodUnknown, Q extends z.ZodType = z.ZodUnknown, A extends Auth = 'branch'>(
    spec: RouteSpec<B, Q, A>,
    handler: Handler<z.output<B>, z.output<Q>, CtxFor<A>>,
  ) {
    const auth = (spec.auth ?? 'branch') as Auth;
    const perms = spec.permission ? (Array.isArray(spec.permission) ? spec.permission : [spec.permission]) : [];
    registerOperation({ method: spec.method, path: `/api/v1${basePath}${spec.path}`, summary: spec.summary, tag, permission: perms, auth, body: spec.body, query: spec.query });
    const chain: Array<(req: Request, res: Response, next: NextFunction) => void> = [...(spec.middleware ?? [])];
    if (auth !== 'public') chain.push(authenticate({ requireTenant: auth === 'tenant' || auth === 'branch', requireBranch: auth === 'branch' }));
    if (auth === 'platform') chain.push(requirePlatformAdmin);
    if (perms.length) chain.push(requirePermission(...perms));
    if (spec.feature) chain.push(requireFeature(spec.feature));
    router[spec.method](spec.path, ...chain, async (req: Request, res: Response, next: NextFunction) => {
      try {
        let body: unknown = req.body;
        let query: unknown = req.query;
        if (spec.body) {
          const r = spec.body.safeParse(req.body ?? {});
          if (!r.success) throw badRequest('Validation failed', z.flattenError(r.error as z.ZodError<Record<string, unknown>>));
          body = r.data;
        }
        if (spec.query) {
          const r = spec.query.safeParse(req.query ?? {});
          if (!r.success) throw badRequest('Invalid query parameters', z.flattenError(r.error as z.ZodError<Record<string, unknown>>));
          query = r.data;
        }
        const result = await handler({ body: body as never, query: query as never, params: req.params as Record<string, string>, ctx: req.ctx as never, req, res });
        if (spec.raw || res.headersSent) return;
        res.status(spec.status ?? res.statusCode ?? 200).json({ data: result ?? null });
      } catch (e) {
        next(e);
      }
    });
  }
  return { router, route, basePath };
}

/** Common Zod helpers. */
export const zId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
export const zMoney = z.number().int('Amounts are integer cents').min(0).max(1_000_000_000_00);
export const zPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const zDateRange = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
