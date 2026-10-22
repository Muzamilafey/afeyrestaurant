import { z } from 'zod';
import type { Request } from 'express';
import { Types } from 'mongoose';
import { createModule, zId } from '../../http/route';
import { PaymentAttempt, MpesaC2BTransaction, IntegrationConfiguration, Order, Payment } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { handleStkCallback, applyStkResult, finalizePaidOrder, emitTicketsClosed } from '../../services/payments';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { env, mocksAllowed } from '../../config/env';
import { logger } from '../../lib/logger';
import { sha256, randomToken } from '../../lib/crypto';
import { withTransaction } from '../../db/connect';
import { getMpesa } from '../../integrations/factory';
import { audit } from '../../services/audit';
import { recordIntegrationResult } from '../../services/integrations';
import { emitBranch } from '../../realtime/bus';

const m = createModule('/mpesa', 'M-Pesa');

function checkCallbackIp(req: Request) {
  const list = env.MPESA_CALLBACK_IP_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length && !list.includes(req.ip ?? '')) {
    logger.warn({ ip: req.ip }, 'M-Pesa callback from non-allowlisted IP rejected');
    throw new AppError(403, 'FORBIDDEN', 'Forbidden');
  }
}

/** Daraja STK callback. Always answers 200 with ResultCode 0 once the payload is authenticated, so Safaricom does not retry forever. */
m.route({ method: 'post', path: '/callback/stk/:attemptId/:token', summary: 'Daraja STK Push callback (public, token-authenticated)', auth: 'public', raw: true }, async ({ params, body, req, res }) => {
  checkCallbackIp(req);
  if (!Types.ObjectId.isValid(params.attemptId)) throw notFound('Callback');
  try {
    const r = await handleStkCallback(params.attemptId, params.token, body);
    res.json({ ResultCode: 0, ResultDesc: r.accepted ? 'Accepted' : 'Received; pending verification' });
  } catch (e) {
    if (e instanceof AppError && e.status === 404) throw e;
    logger.error({ err: e, attemptId: params.attemptId }, 'STK callback processing failed');
    // Non-2xx lets Daraja retry delivery; processing is idempotent.
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Temporary error' });
  }
});

/** C2B validation: accept by default (configurable rejection of unknown bill references could be added per tenant). */
m.route({ method: 'post', path: '/c2b/:integrationId/:key/validation', summary: 'Daraja C2B validation (public)', auth: 'public', raw: true }, async ({ params, req, res }) => {
  checkCallbackIp(req);
  await c2bIntegration(params.integrationId, params.key);
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

async function c2bIntegration(id: string, key: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound('Callback');
  const integ = await IntegrationConfiguration.findOne({ _id: id, kind: 'mpesa' }).setOptions({ skipTenantGuard: true }).lean();
  if (!integ?.callbackKeyHash || integ.callbackKeyHash !== sha256(key)) throw notFound('Callback');
  return integ;
}

m.route({ method: 'post', path: '/c2b/:integrationId/:key/confirmation', summary: 'Daraja C2B confirmation (public)', auth: 'public', raw: true }, async ({ params, body, req, res }) => {
  checkCallbackIp(req);
  const integ = await c2bIntegration(params.integrationId, params.key);
  const b = body as Record<string, string>;
  if (!b?.TransID || !b.TransAmount) throw badRequest('Malformed C2B confirmation');
  const amount = Math.round(Number(b.TransAmount) * 100);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Invalid amount');
  await MpesaC2BTransaction.updateOne(
    { tenantId: integ.tenantId, transId: String(b.TransID) },
    { $setOnInsert: { branchId: integ.branchId ?? undefined, transType: b.TransactionType, amount, shortCode: b.BusinessShortCode, billRef: b.BillRefNumber, msisdn: b.MSISDN, firstName: b.FirstName, transTime: b.TransTime, raw: b } },
    { upsert: true },
  );
  await recordIntegrationResult(integ.tenantId as Types.ObjectId, 'mpesa', { ok: true, action: 'c2b_confirmation', message: `C2B ${b.TransID} received` });
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

m.route({ method: 'get', path: '/c2b', summary: 'Unmatched/matched C2B (Till/Paybill) transactions', permission: P.PAYMENTS_RECEIVE, query: z.object({ status: z.enum(['unmatched', 'matched', 'ignored']).default('unmatched') }) }, async ({ ctx, query }) =>
  MpesaC2BTransaction.find({ tenantId: ctx.tenantId, status: query.status, $or: [{ branchId: ctx.branchId }, { branchId: null }, { branchId: { $exists: false } }] }, { raw: 0 }).sort({ createdAt: -1 }).limit(100).lean(),
);

/** Apply a provider-confirmed C2B transaction to an order. The money is verified by Safaricom's confirmation, not by the cashier. */
m.route({ method: 'post', path: '/c2b/:id/match', summary: 'Apply a C2B transaction to an order', permission: P.PAYMENTS_RECEIVE, body: z.object({ orderId: zId }) }, async ({ ctx, params, body, req }) => {
  const r = await withTransaction(async (session) => {
    const tx = await MpesaC2BTransaction.findOne({ tenantId: ctx.tenantId, _id: params.id }).session(session);
    if (!tx) throw notFound('Transaction');
    if (tx.status !== 'unmatched') throw conflict('Transaction already used', 'C2B_USED');
    const order = await Order.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: body.orderId }).session(session);
    if (!order) throw notFound('Order');
    if (!['open', 'held'].includes(order.status)) throw conflict('Order is closed', 'ORDER_LOCKED');
    const balance = order.totals!.total - order.totals!.paid;
    const apply = Math.min(balance, tx.amount);
    if (apply <= 0) throw conflict('Order has no outstanding balance', 'ALREADY_PAID');
    const [payment] = await Payment.create([{ tenantId: ctx.tenantId, branchId: ctx.branchId, orderId: order._id, orderNumber: order.number, method: 'mpesa', amount: apply, tendered: tx.amount, reference: tx.transId, phone: tx.msisdn, verification: 'provider', receivedBy: ctx.userId, idempotencyKey: `c2b:${tx._id}` }], { session });
    tx.set({ status: 'matched', matchedOrderId: order._id, matchedPaymentId: payment._id, matchedBy: ctx.userId });
    await tx.save({ session });
    order.totals!.paid += apply;
    order.totals!.balance = order.totals!.total - order.totals!.paid;
    order.paymentStatus = order.totals!.balance <= 0 ? 'paid' : 'partial';
    if (order.totals!.balance <= 0) await finalizePaidOrder(order, session);
    await order.save({ session });
    return { payment, order, overpaid: tx.amount - apply };
  });
  await audit(ctx, { action: 'payment.c2b_matched', entity: 'Order', entityId: r.order._id, meta: { transaction: params.id, overpaid: r.overpaid } }, req);
  emitBranch(ctx.tenantId, ctx.branchId, 'order.updated', { id: String(r.order._id) });
  emitTicketsClosed(r.order);
  return r;
});

/** Register C2B URLs with Daraja using a freshly generated callback key. */
m.route({ method: 'post', path: '/c2b/register', summary: 'Register C2B confirmation/validation URLs with Daraja', auth: 'tenant', permission: P.INTEGRATIONS_MANAGE, body: z.object({ responseType: z.enum(['Completed', 'Cancelled']).default('Completed') }) }, async ({ ctx, body, req }) => {
  const integ = await IntegrationConfiguration.findOne({ tenantId: ctx.tenantId, kind: 'mpesa', branchId: null });
  if (!integ) throw notFound('M-Pesa configuration');
  const mp = await getMpesa(ctx.tenantId, null);
  if (mp.mode !== 'daraja') throw badRequest('C2B registration requires real Daraja credentials');
  const key = randomToken(24);
  const base = `${(mp.settings.callbackBaseUrl as string) || env.PUBLIC_API_URL}/api/v1/mpesa/c2b/${integ._id}/${key}`;
  try {
    const r = await mp.client.registerC2BUrls({ confirmationUrl: `${base}/confirmation`, validationUrl: `${base}/validation`, responseType: body.responseType });
    integ.callbackKeyHash = sha256(key);
    await integ.save();
    await recordIntegrationResult(ctx.tenantId, 'mpesa', { ok: true, action: 'c2b_register', message: 'C2B URLs registered' });
    await audit(ctx, { action: 'integration.mpesa_c2b_registered', entity: 'IntegrationConfiguration', entityId: integ._id }, req);
    return { ok: true, response: r };
  } catch (e) {
    await recordIntegrationResult(ctx.tenantId, 'mpesa', { ok: false, action: 'c2b_register', message: (e as Error).message });
    throw new AppError(502, 'MPESA_ERROR', (e as Error).message);
  }
});

m.route({ method: 'get', path: '/attempts', summary: 'STK attempts for reconciliation', permission: [P.PAYMENTS_RECEIVE, P.ACCOUNTING_VIEW], query: z.object({ status: z.string().optional(), from: z.coerce.date().optional() }) }, async ({ ctx, query }) => {
  const f: Record<string, unknown> = { tenantId: ctx.tenantId, branchId: ctx.branchId, method: 'mpesa' };
  if (query.status) f.status = { $in: query.status.split(',') };
  if (query.from) f.createdAt = { $gte: query.from };
  return PaymentAttempt.find(f, { callbackTokenHash: 0 }).sort({ createdAt: -1 }).limit(300).lean();
});

/**
 * DEVELOPMENT ONLY: simulate the provider callback for an attempt created with the mock M-Pesa provider.
 * Disabled in production and refused for attempts sent to real Daraja.
 */
m.route({ method: 'post', path: '/simulate/:attemptId', summary: '[dev] Simulate a callback for a mock STK attempt', permission: P.PAYMENTS_RECEIVE, body: z.object({ resultCode: z.number().int().default(0), amount: z.number().optional(), receipt: z.string().optional() }) }, async ({ ctx, params, body }) => {
  if (!mocksAllowed) throw forbidden('Simulation is disabled');
  const a = await PaymentAttempt.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.attemptId }).lean();
  if (!a) throw notFound('Attempt');
  if (a.provider !== 'mock') throw forbidden('Only simulated attempts can be simulated');
  const r = await applyStkResult(a._id, ctx.tenantId, {
    checkoutRequestId: a.checkoutRequestId!, merchantRequestId: a.merchantRequestId!, resultCode: body.resultCode,
    resultDesc: body.resultCode === 0 ? 'The service request is processed successfully. (SIMULATED)' : 'Request cancelled by user (SIMULATED)',
    amount: body.amount ?? a.amount / 100, mpesaReceipt: body.resultCode === 0 ? body.receipt ?? `SIM${Date.now().toString(36).toUpperCase().slice(-7)}` : undefined, phone: a.phone ?? undefined,
    transactionDate: new Date().toISOString().replace(/\D/g, '').slice(0, 14),
  }, 'simulation');
  return { simulated: true, status: r.attempt.status, resultDesc: r.attempt.resultDesc, duplicate: r.duplicate };
});

export default m;
