import { z } from 'zod';
import { createModule } from '../../http/route';
import { setupBusiness, getBusiness } from '../../services/setup';
import { env, isProd } from '../../config/env';
import { safeEqual } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { audit } from '../../services/audit';
import { LiveMirror } from '../../models';

const m = createModule('', 'Business');

/** Public branding for the sign-in screen and installable app. */
m.route({ method: 'get', path: '/business', summary: 'Business name, logo and colour (public)', auth: 'public' }, async () => {
  const [b, mirror] = await Promise.all([getBusiness(), LiveMirror.findOne({}).lean()]);
  return { liveCopy: mirror ? { lastPushAt: mirror.lastPushAt ?? null } : null, configured: !!b, name: b?.name ?? 'Chili POS', logoUrl: b?.branding?.logoUrl ?? null, icons: b?.branding?.appIcons?.icon192 ? b.branding.appIcons : null, primaryColor: b?.branding?.primaryColor ?? '#07963C', setupRequiresToken: !b && !!env.SETUP_TOKEN };
});

/**
 * First-run setup. Only works while no business exists. In production a SETUP_TOKEN must be configured and
 * supplied, so an internet-facing server that has not been set up yet cannot be claimed by someone else.
 */
m.route(
  {
    method: 'post', path: '/setup', summary: 'First-run setup: business, first branch and owner account', auth: 'public', status: 201,
    body: z.object({
      setupToken: z.string().optional(),
      name: z.string().min(2).max(120), contactPhone: z.string().max(20).optional(),
      branch: z.object({ name: z.string().min(2).max(80), code: z.string().regex(/^[A-Za-z0-9]{2,10}$/), address: z.string().max(200).optional() }),
      owner: z.object({ name: z.string().min(2).max(80), email: z.email(), password: z.string().min(10).max(200) }),
    }),
  },
  async ({ body, req }) => {
    if (isProd && !env.SETUP_TOKEN) throw new AppError(403, 'SETUP_DISABLED', 'Set SETUP_TOKEN on the server (or run `npm run setup`) to complete first-run setup');
    if (env.SETUP_TOKEN && (!body.setupToken || !safeEqual(body.setupToken, env.SETUP_TOKEN))) throw new AppError(403, 'SETUP_TOKEN_INVALID', 'Invalid setup token');
    const { setupToken: _t, ...input } = body;
    const r = await setupBusiness(input);
    await audit({ tenantId: r.business._id, userId: r.owner._id, userName: r.owner.name } as never, { action: 'business.setup', entity: 'Business', entityId: r.business._id }, req);
    return { ok: true };
  },
);

export default m;
