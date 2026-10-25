import { z } from 'zod';
import { createModule } from '../../http/route';
import { PERMISSIONS as P } from '../../auth/permissions';
import { EtimsCounter, EtimsInvoice } from '../../models';
import { badRequest, notFound } from '../../lib/errors';
import { audit } from '../../services/audit';
import { loadIntegration, recordIntegrationResult, saveIntegration } from '../../services/integrations';
import { getEtims, isValidKraPin, processEtims, retryInvoice } from '../../services/etims';
import { EtimsError, MockEtimsClient, OSCU_URLS, OscuClient } from '../../integrations/etims/oscu';
import { mocksAllowed } from '../../config/env';

const m = createModule('/etims', 'KRA eTIMS');

m.route({ method: 'get', path: '', summary: 'eTIMS status: invoice counts, recent and failing invoices', permission: [P.INTEGRATIONS_MANAGE, P.REPORTS_SALES] }, async ({ ctx }) => {
  const cfg = await loadIntegration(ctx.tenantId, 'etims');
  let series: string | null = null;
  let problem: string | null = null;
  try {
    series = (await getEtims(ctx.tenantId))?.series ?? null;
  } catch (e) {
    problem = (e as Error).message;
  }
  const filter = { tenantId: ctx.tenantId, ...(series ? { series } : {}) };
  const [counts, recent, failing, counter] = await Promise.all([
    EtimsInvoice.aggregate([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    EtimsInvoice.find(filter).sort({ invcNo: -1 }).limit(30).lean(),
    EtimsInvoice.find({ ...filter, $or: [{ status: { $in: ['rejected', 'duplicate'] } }, { status: 'queued', attempts: { $gt: 0 } }] }).sort({ invcNo: 1 }).limit(50).lean(),
    series ? EtimsCounter.findOne({ tenantId: ctx.tenantId, series }).lean() : null,
  ]);
  return {
    enabled: !!cfg?.enabled, simulated: cfg?.provider === 'mock', environment: cfg?.environment ?? null, series, problem,
    hasKey: !!cfg?.secrets.cmcKey, lastInvcNo: counter?.lastInvcNo ?? null,
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])), recent, failing,
  };
});

/**
 * One-time device initialisation: KRA checks the PIN, branch and OSCU serial number it approved and returns the
 * communication key (cmcKey), which is stored encrypted like any other integration secret.
 */
m.route({
  method: 'post', path: '/initialize', summary: 'Initialise the OSCU device with KRA and store its communication key', permission: P.INTEGRATIONS_MANAGE,
  body: z.object({ tin: z.string().trim().toUpperCase(), bhfId: z.string().regex(/^\d{2}$/).default('00'), deviceSerial: z.string().trim().min(1).max(100), environment: z.enum(['sandbox', 'production']).default('sandbox'), simulated: z.boolean().default(false) }),
}, async ({ ctx, body, req }) => {
  if (!isValidKraPin(body.tin)) throw badRequest('Enter the KRA PIN as on your certificate, e.g. P051234567A');
  if (body.simulated && !mocksAllowed) throw badRequest('The simulated eTIMS connection is disabled in production');
  const cfg = await loadIntegration(ctx.tenantId, 'etims');
  const client = body.simulated ? new MockEtimsClient() : new OscuClient({ baseUrl: (cfg?.settings.baseUrl as string) || OSCU_URLS[body.environment], tin: body.tin, bhfId: body.bhfId });
  let info;
  try {
    info = await client.initialize(body.deviceSerial);
  } catch (e) {
    const msg = e instanceof EtimsError ? e.message : 'Could not reach KRA';
    await recordIntegrationResult(ctx.tenantId, 'etims', { ok: false, action: 'initialize', message: msg });
    throw badRequest(`KRA refused the device initialisation — ${msg}. Check the PIN, branch ID and the OSCU serial number KRA approved.`);
  }
  await saveIntegration(ctx.tenantId, 'etims', {
    provider: body.simulated ? 'mock' : 'oscu', environment: body.simulated ? 'mock' : body.environment,
    enabled: cfg?.enabled ?? false,
    settings: { ...(cfg?.settings ?? {}), tin: body.tin, bhfId: body.bhfId, deviceSerial: body.deviceSerial, sdcId: info.sdcId, mrcNo: info.mrcNo, taxpayerName: info.taxpayerName, branchName: info.branchName },
    secrets: { cmcKey: info.cmcKey },
  }, ctx.userId);
  await recordIntegrationResult(ctx.tenantId, 'etims', { ok: true, action: 'initialize', message: `Device initialised${info.taxpayerName ? ` for ${info.taxpayerName}` : ''} (${info.sdcId ?? 'no CU number'})`, simulated: client.simulated });
  await audit(ctx, { action: 'integration.etims_initialized', meta: { tin: body.tin, bhfId: body.bhfId, environment: body.environment, simulated: client.simulated } }, req);
  return { sdcId: info.sdcId, mrcNo: info.mrcNo, taxpayerName: info.taxpayerName, branchName: info.branchName, simulated: client.simulated };
});

m.route({ method: 'post', path: '/invoices/:id/retry', summary: 'Resend an invoice KRA refused (same invoice number)', permission: P.INTEGRATIONS_MANAGE }, async ({ ctx, params, req }) => {
  const inv = await retryInvoice(ctx.tenantId, params.id);
  if (!inv) throw notFound('Invoice');
  await audit(ctx, { action: 'etims.invoice_retry', entity: 'EtimsInvoice', entityId: inv._id, meta: { invcNo: inv.invcNo } }, req);
  await processEtims(ctx.tenantId);
  return EtimsInvoice.findOne({ tenantId: ctx.tenantId, _id: inv._id }).lean();
});

m.route({ method: 'post', path: '/send', summary: 'Send waiting invoices to KRA now', permission: P.INTEGRATIONS_MANAGE }, async ({ ctx }) => {
  await processEtims(ctx.tenantId);
  return { ok: true };
});

export default m;
