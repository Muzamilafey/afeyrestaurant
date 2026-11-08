import crypto from 'node:crypto';
import express from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { createModule } from '../../http/route';
import { PERMISSIONS as P } from '../../auth/permissions';
import { Business, DisplayPairing } from '../../models';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/crypto';

/**
 * Customer-facing display on a separate device. The till pairs it with a 6-digit code (valid 10 minutes); the
 * display then shows whatever the till publishes for it — the order being rung up, the amount to pay, the M-Pesa
 * prompt status, "thank you". The screen state lives in memory: it is momentary, not a record.
 * (A second monitor on the till PC itself needs none of this: the tabs talk directly in the browser.)
 */
const m = createModule('/display', 'Customer display');
const screens = new Map<string, { state: unknown; at: number }>();

m.route({ method: 'post', path: '/pair', summary: 'Start pairing a customer display (returns a 6-digit code)', permission: P.ORDERS_CREATE, body: z.object({ name: z.string().max(40).optional() }), status: 201 }, async ({ ctx, body }) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = String(crypto.randomInt(100000, 1000000));
    try {
      const d = await DisplayPairing.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, name: body.name || 'Customer display', createdBy: ctx.userId, code, codeExpiresAt: new Date(Date.now() + 10 * 60_000) });
      return { pairingId: String(d._id), code, expiresAt: d.codeExpiresAt };
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  throw new AppError(503, 'TRY_AGAIN', 'Could not create a pairing code, try again');
});

m.route({ method: 'get', path: '/pairings', summary: 'Displays paired at this branch', permission: P.ORDERS_CREATE }, async ({ ctx }) =>
  (await DisplayPairing.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, active: true, pairedAt: { $exists: true } }).sort({ pairedAt: -1 }).lean()).map((d) => ({ _id: d._id, name: d.name, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt })));

m.route({ method: 'delete', path: '/pairings/:id', summary: 'Unpair a display', permission: P.ORDERS_CREATE }, async ({ ctx, params }) => {
  await DisplayPairing.updateOne({ tenantId: ctx.tenantId, _id: params.id }, { $set: { active: false }, $unset: { tokenHash: 1, code: 1 } });
  screens.delete(params.id);
  return { ok: true };
});

/** The display enters the code once and receives its own token. */
m.route({ method: 'post', path: '/claim', summary: 'Display: exchange a pairing code for a display token', auth: 'public', body: z.object({ code: z.string().regex(/^\d{6}$/) }) }, async ({ body }) => {
  const d = await DisplayPairing.findOne({ code: body.code, active: true, codeExpiresAt: { $gt: new Date() } }).setOptions({ skipTenantGuard: true });
  if (!d) {
    await new Promise((r) => setTimeout(r, 800));
    throw badRequest('That code is wrong or has expired — create a new one on the till');
  }
  const token = randomToken(32);
  d.set({ tokenHash: sha256(token), pairedAt: new Date(), code: undefined, codeExpiresAt: undefined });
  await d.save();
  return { token, pairingId: String(d._id), name: d.name };
});

/** The till publishes what its customer display should show. */
m.route({ method: 'put', path: '/screens/:id', summary: 'Till: publish the customer display screen', permission: P.ORDERS_CREATE, middleware: [express.json({ limit: '64kb' })], body: z.object({ state: z.record(z.string(), z.unknown()) }) }, async ({ ctx, params, body }) => {
  if (!Types.ObjectId.isValid(params.id)) throw notFound('Display');
  const d = await DisplayPairing.findOne({ tenantId: ctx.tenantId, _id: params.id, active: true }).select('_id').lean();
  if (!d) throw notFound('Display');
  screens.set(params.id, { state: body.state, at: Date.now() });
  return { ok: true };
});

/** The display polls this with its token (about once a second). */
m.route({ method: 'get', path: '/screen', summary: 'Display: current screen (display token)', auth: 'public' }, async ({ req }) => {
  const token = /^Display (.+)$/.exec(req.header('authorization') ?? '')?.[1];
  const d = token ? await DisplayPairing.findOne({ tokenHash: sha256(token), active: true }).setOptions({ skipTenantGuard: true }) : null;
  if (!d) throw new AppError(401, 'DISPLAY_UNPAIRED', 'This display is not paired');
  if (!d.lastSeenAt || Date.now() - new Date(d.lastSeenAt as unknown as Date).getTime() > 60_000) await DisplayPairing.updateOne({ _id: d._id }, { $set: { lastSeenAt: new Date() } }).setOptions({ skipTenantGuard: true });
  const biz = await Business.findById(d.tenantId).lean();
  const s = screens.get(String(d._id));
  return { name: d.name, business: { name: biz?.name, logoUrl: biz?.branding?.logoUrl ?? null, color: biz?.branding?.primaryColor ?? '#07963C' }, state: s && Date.now() - s.at < 6 * 3600_000 ? s.state : null, at: s?.at ?? null };
});

export default m;
