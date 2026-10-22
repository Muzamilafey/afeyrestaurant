import { randomUUID } from 'node:crypto';
import type { Types, ClientSession } from 'mongoose';
import { Order, type OrderDoc, Payment, PaymentAttempt, Refund, Customer, LoyaltyAccount, LoyaltyTransaction, Tenant, Branch, Receipt, KitchenTicket, User } from '../models';
import type { BranchContext } from '../http/context';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { PERMISSIONS as P } from '../auth/permissions';
import { withTransaction } from '../db/connect';
import { postMovement, requirements } from './inventory';
import { RecipeVersion } from '../models';
import { nextNumber } from './counters';
import { audit } from './audit';
import { notify } from './notify';
import { broadcastOrder, releaseTableIfFree } from './orders';
import { emitBranch, emitStation } from '../realtime/bus';
import { resolveApproval, type ApprovalInput } from './approval';
import { getMpesa } from '../integrations/factory';
import { parseStkCallback, STK_RESULT_CODES, type StkCallbackParsed } from '../integrations/mpesa/daraja';
import { ProviderError } from '../integrations/http';
import { normalizeKePhone } from '../lib/phone';
import { randomToken, sha256 } from '../lib/crypto';
import { env } from '../config/env';
import { recordIntegrationResult } from './integrations';
import { receiptDoc, docToText, type ReceiptData } from './receipt';
import { findOpenDrawer, noDrawerMessage } from './cash';
import { logger } from '../lib/logger';
import { toMajor } from '../lib/money';

type Method = 'cash' | 'card' | 'mpesa' | 'qr' | 'account' | 'voucher' | 'complimentary';

export interface PaymentInput {
  method: Exclude<Method, 'mpesa'> | 'mpesa_manual';
  amount: number;
  tendered?: number;
  reference?: string;
  customerId?: string;
  reason?: string;
  idempotencyKey: string;
  approval?: ApprovalInput;
}


/**
 * Record a confirmed non-M-Pesa-STK payment (cash, card, QR, credit account, or a manager-confirmed M-Pesa
 * payment that the customer made outside STK). Idempotent by idempotencyKey.
 */
export async function recordPayment(ctx: BranchContext, orderId: string, input: PaymentInput) {
  const dup = await Payment.findOne({ tenantId: ctx.tenantId, idempotencyKey: input.idempotencyKey }).lean();
  if (dup) return { payment: dup, order: await Order.findOne({ tenantId: ctx.tenantId, _id: dup.orderId }), duplicate: true };

  let verification: 'cash' | 'manual' | 'provider' = 'manual';
  let manual: { by: Types.ObjectId; reason: string } | undefined;
  const method: Method = input.method === 'mpesa_manual' ? 'mpesa' : input.method;
  if (input.method === 'cash') verification = 'cash';
  if (input.method === 'card' || input.method === 'qr') {
    // Card/QR are confirmed on an external terminal; the approval code is required as evidence. Card numbers are never collected.
    if (!input.reference) throw badRequest('Enter the terminal approval/reference code');
  }
  if (input.method === 'mpesa_manual') {
    if (!input.reference || !/^[A-Z0-9]{10}$/.test(input.reference.toUpperCase())) throw badRequest('Enter the 10-character M-Pesa transaction code');
    if (!input.reason) throw badRequest('A reason is required for manual payment confirmation');
    const by = await resolveApproval(ctx, P.PAYMENTS_MANUAL_CONFIRM, input.approval, 'Manually confirming an M-Pesa payment');
    manual = { by, reason: input.reason };
    input.reference = input.reference.toUpperCase();
  }
  if (input.method === 'account') await resolveApproval(ctx, P.PAYMENTS_CREDIT_SALE, input.approval, 'Credit (account) sales');
  if (input.method === 'complimentary') throw badRequest('Use complimentary items rather than a complimentary payment');

  const result = await withTransaction(async (session) => {
    const order = await Order.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: orderId }).session(session);
    if (!order) throw notFound('Order');
    if (!['open', 'held'].includes(order.status)) throw conflict(`Order is ${order.status}`, 'ORDER_LOCKED');
    const balance = order.totals!.total - order.totals!.paid;
    if (balance <= 0) throw conflict('Order is already fully paid', 'ALREADY_PAID');
    if (input.amount <= 0) throw badRequest('Amount must be positive');
    if (input.amount > balance) throw badRequest(`Amount exceeds the outstanding balance of ${toMajor(balance).toFixed(2)}`);

    let tendered = input.amount;
    let change = 0;
    let cashSessionId: Types.ObjectId | undefined;
    if (method === 'cash') {
      const { drawer: cs, mode } = await findOpenDrawer(ctx, session);
      if (!cs) throw new AppError(409, 'NO_CASH_SESSION', noDrawerMessage(mode, 'before accepting cash'));
      cashSessionId = cs._id;
      tendered = input.tendered ?? input.amount;
      if (tendered < input.amount) throw badRequest('Cash tendered is less than the amount');
      change = tendered - input.amount;
    }
    let customerId: Types.ObjectId | undefined;
    if (method === 'account') {
      const cust = await Customer.findOne({ tenantId: ctx.tenantId, _id: input.customerId ?? order.customerId }).session(session);
      if (!cust?.credit?.approved) throw conflict('Customer does not have an approved credit account', 'CREDIT_NOT_APPROVED');
      if ((cust.credit.balance ?? 0) + input.amount > (cust.credit.limit ?? 0)) throw conflict('This sale would exceed the customer credit limit', 'CREDIT_LIMIT');
      cust.credit.balance = (cust.credit.balance ?? 0) + input.amount;
      await cust.save({ session });
      customerId = cust._id;
    }
    const [payment] = await Payment.create(
      [{
        tenantId: ctx.tenantId, branchId: ctx.branchId, orderId: order._id, orderNumber: order.number, method, amount: input.amount, tendered, change,
        reference: input.reference, customerId, verification, manualConfirmation: manual, receivedBy: ctx.userId, cashSessionId, idempotencyKey: input.idempotencyKey,
      }],
      { session },
    );
    order.totals!.paid += input.amount;
    order.totals!.balance = order.totals!.total - order.totals!.paid;
    order.cashierId = ctx.userId;
    order.paymentStatus = order.totals!.balance <= 0 ? 'paid' : 'partial';
    if (order.totals!.balance <= 0) await finalizePaidOrder(order, session);
    await order.save({ session });
    return { payment, order };
  });
  if (manual || method === 'card' || method === 'account') {
    await audit(ctx, { action: `payment.${input.method}`, entity: 'Order', entityId: result.order._id, reason: input.reason, approvedBy: manual?.by, meta: { amount: input.amount, reference: input.reference } });
  }
  await afterPayment(result.order);
  return { ...result, duplicate: false };
}

/**
 * Close a fully paid order: receipt number, stock deduction (exactly once), loyalty and table release.
 * Runs inside the payment transaction.
 */
export async function finalizePaidOrder(order: OrderDoc, session: ClientSession) {
  if (order.status === 'paid') return;
  const branch = await Branch.findOne({ tenantId: order.tenantId, _id: order.branchId }).session(session).lean();
  order.status = 'paid';
  order.paymentStatus = 'paid';
  order.paidAt = new Date();
  order.receiptNumber = await nextNumber(order.tenantId as Types.ObjectId, branch?.settings?.receiptPrefix ?? 'RC', branch?.code ?? 'BR', session);
  await Receipt.create([{ tenantId: order.tenantId, branchId: order.branchId, orderId: order._id, number: order.receiptNumber, kind: 'receipt' }], { session });
  if (!order.stockDeducted) {
    await deductStockForOrder(order, session);
    order.stockDeducted = true;
  }
  if (order.customerId && !order.loyaltyAwarded) {
    await awardLoyalty(order, session);
    order.loyaltyAwarded = true;
  }
  await serveTicketsOnPayment(order, session);
}

/** Order types where food is served before the bill is settled — paying means the guest has been served. */
const SERVED_BEFORE_PAYMENT = new Set(['dine_in', 'bar_counter', 'room_service']);
const ACTIVE_TICKET_STATUSES = ['pending', 'accepted', 'preparing', 'ready'];

/**
 * Clear a paid order from the kitchen and bar displays: its open tickets become completed and their lines served.
 * Dine-in, bar and room-service orders are paid after eating, so every open ticket is closed. Takeaway, delivery and
 * online orders are often paid up front, so only tickets that are already ready are closed — a prepaid order that has
 * not been cooked yet stays on the display. Runs inside the payment transaction; the order is saved by the caller.
 */
export async function serveTicketsOnPayment(order: OrderDoc, session: ClientSession) {
  const statuses = SERVED_BEFORE_PAYMENT.has(order.type) ? ACTIVE_TICKET_STATUSES : ['ready'];
  const tickets = await KitchenTicket.find({ tenantId: order.tenantId, orderId: order._id, status: { $in: statuses } }).session(session);
  if (!tickets.length) return;
  const now = new Date();
  const served = new Set<string>();
  for (const t of tickets) {
    t.status = 'completed';
    t.completedAt = now;
    t.completedVia = 'payment';
    for (const it of t.items) {
      if (it.status === 'cancelled') continue;
      it.status = 'served';
      served.add(String(it.lineId));
    }
    await t.save({ session });
  }
  for (const line of order.items) {
    if (line.voided || line.status === 'cancelled' || !served.has(String(line.lineId))) continue;
    line.status = 'served';
    line.servedAt ??= now;
  }
}

/** Refresh the kitchen and bar displays after a payment has committed (tickets may have been closed). */
export function emitTicketsClosed(order: { tenantId: unknown; branchId: unknown; _id: unknown; status?: string | null }) {
  if (order.status !== 'paid') return;
  for (const station of ['kitchen', 'bar']) {
    emitStation(order.tenantId as Types.ObjectId, order.branchId as Types.ObjectId, station, 'ticket.updated', { orderId: String(order._id), status: 'completed', via: 'payment' });
  }
}

/** Deduct recipe ingredients for every sold line. Ledger idempotency keys make retries and re-syncs safe. */
export async function deductStockForOrder(order: OrderDoc, session: ClientSession) {
  const versionIds = order.items.filter((i) => !i.voided && i.recipeVersionId).map((i) => i.recipeVersionId);
  if (!versionIds.length) return;
  const versions = await RecipeVersion.find({ tenantId: order.tenantId, _id: { $in: versionIds } }).session(session).lean();
  for (const line of order.items) {
    if (line.voided || !line.recipeVersionId) continue;
    const v = versions.find((x) => String(x._id) === String(line.recipeVersionId));
    if (!v) continue;
    for (const need of requirements(v as never, line.qty)) {
      await postMovement(
        {
          tenantId: order.tenantId as Types.ObjectId, branchId: order.branchId as Types.ObjectId, ingredientId: need.ingredientId,
          type: line.complimentary ? 'complimentary' : 'sale', qty: -need.qty, idempotencyKey: `sale:${order._id}:${line.lineId}:${need.ingredientId}`,
          refType: 'Order', refId: order._id, refLine: line.lineId, recipeVersionId: v._id,
          // The sale already happened; shortages were checked (or overridden with approval) when the item was ordered.
          allowNegative: true,
        },
        session,
      );
    }
  }
}

async function awardLoyalty(order: OrderDoc, session: ClientSession) {
  const tenant = await Tenant.findById(order.tenantId).session(session).lean();
  const per100 = tenant?.settings?.loyaltyPointsPer100 ?? 0;
  const points = Math.floor((order.totals!.total / 100 / 100) * per100);
  await Customer.updateOne({ tenantId: order.tenantId, _id: order.customerId }, { $inc: { visits: 1, totalSpent: order.totals!.total }, $set: { lastVisitAt: new Date() } }, { session });
  if (points <= 0) return;
  const key = `earn:${order._id}`;
  if (await LoyaltyTransaction.findOne({ tenantId: order.tenantId, idempotencyKey: key }).session(session)) return;
  await LoyaltyTransaction.create([{ tenantId: order.tenantId, customerId: order.customerId, type: 'earn', points, orderId: order._id, idempotencyKey: key }], { session });
  await LoyaltyAccount.updateOne({ tenantId: order.tenantId, customerId: order.customerId }, { $inc: { points, lifetimePoints: points } }, { upsert: true, session });
}

/** Side effects after the transaction commits: realtime, table release, customer notifications. */
async function afterPayment(order: OrderDoc) {
  broadcastOrder(order);
  emitBranch(order.tenantId, order.branchId, 'payment.updated', { orderId: String(order._id), paymentStatus: order.paymentStatus });
  if (order.status !== 'paid') return;
  emitTicketsClosed(order);
  if (order.tableId) {
    const ctxLike = { tenantId: order.tenantId, branchId: order.branchId } as BranchContext;
    await releaseTableIfFree(ctxLike, order.tableId as Types.ObjectId, 'cleaning');
  }
  if (order.customerPhone) {
    const payments = await Payment.find({ tenantId: order.tenantId, orderId: order._id }).lean();
    await notify(order.tenantId as Types.ObjectId, {
      event: 'payment_confirmation', channel: 'sms', to: order.customerPhone,
      vars: { order_number: order.number, amount: toMajor(order.totals!.total).toFixed(2), payment_method: [...new Set(payments.map((p) => (p.method === 'mpesa' ? 'M-Pesa' : p.method)))].join(' + '), receipt_number: order.receiptNumber, customer_name: order.customerName },
      dedupeKey: `paid:${order._id}:sms`, refType: 'Order', refId: order._id,
    }).catch((e) => logger.warn({ err: e }, 'Failed to queue payment SMS'));
  }
}

// ───────────────────────────── M-Pesa STK Push ─────────────────────────────

export async function initiateMpesa(ctx: BranchContext, orderId: string, input: { phone: string; amount: number; idempotencyKey: string }) {
  const existing = await PaymentAttempt.findOne({ tenantId: ctx.tenantId, idempotencyKey: input.idempotencyKey }).lean();
  if (existing) return existing;
  const tenant = await Tenant.findById(ctx.tenantId).lean();
  const phone = normalizeKePhone(input.phone, tenant?.settings?.countryCode ?? '254');
  if (!phone) throw badRequest('Enter a valid Safaricom number, e.g. 0712345678');
  if (input.amount % 100 !== 0) throw badRequest('M-Pesa amounts must be whole shillings');
  const order = await Order.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: orderId });
  if (!order) throw notFound('Order');
  if (!['open', 'held'].includes(order.status)) throw conflict(`Order is ${order.status}`, 'ORDER_LOCKED');
  const balance = order.totals!.total - order.totals!.paid;
  if (input.amount <= 0 || input.amount > balance) throw badRequest('Amount must be between 1 and the outstanding balance');
  // Only one live prompt per order at a time prevents double charging.
  const live = await PaymentAttempt.findOne({ tenantId: ctx.tenantId, orderId: order._id, method: 'mpesa', status: { $in: ['initiated', 'pending'] }, expiresAt: { $gt: new Date() } }).lean();
  if (live) throw conflict('An M-Pesa prompt is already pending for this order. Wait for it to complete or cancel it.', 'MPESA_PENDING', { attemptId: String(live._id) });

  const mp = await getMpesa(ctx.tenantId, ctx.branchId);
  const token = randomToken(24);
  const timeout = tenant?.settings?.mpesaTimeoutSeconds ?? 90;
  const attempt = await PaymentAttempt.create({
    tenantId: ctx.tenantId, branchId: ctx.branchId, orderId: order._id, method: 'mpesa', amount: input.amount, phone, idempotencyKey: input.idempotencyKey,
    status: 'initiated', provider: mp.mode === 'mock' ? 'mock' : 'daraja', environment: mp.environment, callbackTokenHash: sha256(token),
    expiresAt: new Date(Date.now() + timeout * 1000), initiatedBy: ctx.userId,
  });
  const callbackUrl = `${(mp.settings.callbackBaseUrl as string) || env.PUBLIC_API_URL}/api/v1/mpesa/callback/stk/${attempt._id}/${token}`;
  const accountRef = String(mp.settings.accountReferenceFormat || '{order}').replace('{order}', order.number.split('-').pop()!).replace('{branch}', '').slice(0, 12);
  try {
    if (mp.mode === 'mock') {
      attempt.merchantRequestId = `MOCK-MR-${randomUUID().slice(0, 8)}`;
      attempt.checkoutRequestId = `ws_CO_MOCK_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    } else {
      const r = await mp.client.stkPush({ phone, amountKes: input.amount / 100, callbackUrl, accountReference: accountRef || order.number.slice(-12), description: String(mp.settings.transactionDesc || 'Payment').slice(0, 13) });
      attempt.merchantRequestId = r.merchantRequestId;
      attempt.checkoutRequestId = r.checkoutRequestId;
    }
    attempt.status = 'pending';
    await attempt.save();
    await recordIntegrationResult(ctx.tenantId, 'mpesa', { ok: true, action: 'stk_push', message: `STK prompt sent (${attempt.checkoutRequestId})`, simulated: mp.mode === 'mock' });
  } catch (e) {
    attempt.status = 'error';
    attempt.error = (e as Error).message.slice(0, 300);
    await attempt.save();
    await recordIntegrationResult(ctx.tenantId, 'mpesa', { ok: false, action: 'stk_push', message: attempt.error });
    throw new AppError(502, 'MPESA_ERROR', e instanceof ProviderError ? e.message : 'Could not reach M-Pesa. Try again or use another payment method.');
  }
  emitBranch(ctx.tenantId, ctx.branchId, 'payment.updated', { orderId: String(order._id), attemptId: String(attempt._id), status: attempt.status });
  return attempt.toObject();
}

/**
 * Apply a verified STK result to its attempt. Idempotent: duplicate and late callbacks never create a second payment.
 * Verification: amount must equal the requested amount, CheckoutRequestID/MerchantRequestID must match,
 * and the M-Pesa receipt number must be unique.
 */
export async function applyStkResult(attemptId: Types.ObjectId, tenantId: Types.ObjectId, r: StkCallbackParsed, source: 'callback' | 'query' | 'simulation') {
  const outcome = await withTransaction(async (session) => {
    const attempt = await PaymentAttempt.findOne({ tenantId, _id: attemptId }).session(session);
    if (!attempt) throw notFound('Payment attempt');
    if (source === 'callback') {
      attempt.callbackCount = (attempt.callbackCount ?? 0) + 1;
      attempt.lastCallbackAt = new Date();
    }
    if (attempt.checkoutRequestId !== r.checkoutRequestId || (r.merchantRequestId && attempt.merchantRequestId && attempt.merchantRequestId !== r.merchantRequestId)) {
      await attempt.save({ session });
      throw unprocessable('Callback does not match this payment attempt', 'MPESA_MISMATCH');
    }
    if (attempt.status === 'succeeded') {
      await attempt.save({ session });
      return { attempt, duplicate: true as const };
    }
    attempt.resultCode = r.resultCode;
    attempt.resultDesc = r.resultDesc || STK_RESULT_CODES[r.resultCode];
    if (r.resultCode !== 0) {
      // Failed/cancelled. A late failure after a success is ignored above; a late success after a timeout is still honoured below.
      attempt.status = r.resultCode === 1032 ? 'cancelled' : r.resultCode === 1037 ? 'timeout' : 'failed';
      await attempt.save({ session });
      return { attempt, duplicate: false as const };
    }
    const expected = attempt.amount / 100;
    if (r.amount === undefined || Math.round(r.amount * 100) !== attempt.amount) {
      attempt.status = 'error';
      attempt.error = `Amount mismatch: expected ${expected}, provider reported ${r.amount}`;
      await attempt.save({ session });
      return { attempt, duplicate: false as const, mismatch: true };
    }
    if (!r.mpesaReceipt) {
      attempt.status = 'error';
      attempt.error = 'Successful result without an M-Pesa receipt number';
      await attempt.save({ session });
      return { attempt, duplicate: false as const, mismatch: true };
    }
    const order = await Order.findOne({ tenantId, _id: attempt.orderId }).session(session);
    if (!order) throw notFound('Order');
    attempt.mpesaReceipt = r.mpesaReceipt;
    attempt.providerAmount = r.amount;
    attempt.providerPhone = r.phone;
    attempt.providerTransactionDate = r.transactionDate;
    attempt.status = 'succeeded';
    const applicable = ['open', 'held'].includes(order.status) ? Math.min(attempt.amount, order.totals!.total - order.totals!.paid) : 0;
    const [payment] = await Payment.create(
      [{
        tenantId, branchId: order.branchId, orderId: order._id, orderNumber: order.number, attemptId: attempt._id, method: 'mpesa', amount: applicable,
        tendered: attempt.amount, change: 0, reference: r.mpesaReceipt, phone: r.phone, verification: 'provider', receivedBy: attempt.initiatedBy,
        idempotencyKey: `mpesa:${attempt._id}`,
      }],
      { session },
    );
    attempt.paymentId = payment._id;
    if (applicable > 0) {
      order.totals!.paid += applicable;
      order.totals!.balance = order.totals!.total - order.totals!.paid;
      order.paymentStatus = order.totals!.balance <= 0 ? 'paid' : 'partial';
      if (order.totals!.balance <= 0) await finalizePaidOrder(order, session);
      await order.save({ session });
    }
    await attempt.save({ session });
    // Money received for an order that was already settled (late callback) is flagged for refund/reconciliation.
    return { attempt, duplicate: false as const, order, overpaid: attempt.amount - applicable };
  });
  if ('order' in outcome && outcome.order) {
    await afterPayment(outcome.order);
    if (outcome.overpaid && outcome.overpaid > 0) {
      await audit(null, { action: 'payment.mpesa_overpayment', entity: 'Order', entityId: outcome.order._id, meta: { amount: outcome.overpaid, receipt: r.mpesaReceipt, tenantId: String(tenantId) } });
    }
  }
  const a = outcome.attempt;
  emitBranch(tenantId, a.branchId, 'payment.updated', { orderId: String(a.orderId), attemptId: String(a._id), status: a.status, resultDesc: a.resultDesc });
  return outcome;
}

/** Handle the raw Daraja STK callback. Authenticated by the per-attempt token embedded in the callback URL. */
export async function handleStkCallback(attemptId: string, token: string, body: unknown) {
  const attempt = await PaymentAttempt.findOne({ _id: attemptId }).setOptions({ skipTenantGuard: true }).lean();
  if (!attempt || !attempt.callbackTokenHash || attempt.callbackTokenHash !== sha256(token)) throw new AppError(404, 'NOT_FOUND', 'Unknown callback');
  const parsed = parseStkCallback(body);
  if (!parsed) throw badRequest('Malformed STK callback');
  const mp = await getMpesa(attempt.tenantId as Types.ObjectId, attempt.branchId as Types.ObjectId).catch(() => null);
  // Defence in depth: optionally confirm a success callback with an STK status query before trusting it.
  if (parsed.resultCode === 0 && mp?.mode === 'daraja' && mp.settings.verifyCallbackWithQuery !== false) {
    try {
      const q = await mp.client.stkQuery(parsed.checkoutRequestId);
      if (q.pending || q.resultCode !== 0) {
        logger.warn({ attemptId, q: q.resultCode }, 'STK callback success not confirmed by status query');
        await PaymentAttempt.updateOne({ tenantId: attempt.tenantId, _id: attempt._id }, { $set: { error: 'Success callback not confirmed by status query — will re-query' }, $inc: { callbackCount: 1 } });
        return { accepted: false };
      }
    } catch (e) {
      // Query unavailable: keep the attempt pending; the reconciliation job re-queries later.
      await PaymentAttempt.updateOne({ tenantId: attempt.tenantId, _id: attempt._id }, { $set: { error: `Verification query failed: ${(e as Error).message}` }, $inc: { callbackCount: 1 } });
      return { accepted: false };
    }
  }
  await applyStkResult(attempt._id, attempt.tenantId as Types.ObjectId, parsed, 'callback');
  return { accepted: true };
}

/** Poll Daraja for attempts whose callback has not arrived (reconciliation job and "check status" button). */
export async function queryAttempt(tenantId: Types.ObjectId, attemptId: Types.ObjectId) {
  const attempt = await PaymentAttempt.findOne({ tenantId, _id: attemptId });
  if (!attempt) throw notFound('Payment attempt');
  if (!['pending', 'timeout', 'error', 'initiated'].includes(attempt.status) || !attempt.checkoutRequestId) return attempt.toObject();
  const mp = await getMpesa(tenantId, attempt.branchId as Types.ObjectId);
  if (mp.mode === 'mock') {
    if (attempt.expiresAt && attempt.expiresAt < new Date() && attempt.status === 'pending') {
      attempt.status = 'timeout';
      attempt.resultDesc = 'No response from customer (simulated)';
      await attempt.save();
    }
    return attempt.toObject();
  }
  attempt.queryCount = (attempt.queryCount ?? 0) + 1;
  attempt.lastQueryAt = new Date();
  await attempt.save();
  const q = await mp.client.stkQuery(attempt.checkoutRequestId);
  if (q.pending) return attempt.toObject();
  if (q.resultCode === 0) {
    // The query confirms success but does not return the receipt/amount; we wait for the callback for those
    // details, unless the attempt has expired, in which case it is flagged for manual reconciliation.
    if (attempt.expiresAt && attempt.expiresAt < new Date(Date.now() - 10 * 60_000)) {
      attempt.error = 'Daraja reports success but no callback was received. Confirm the M-Pesa code manually.';
      await attempt.save();
    }
    return attempt.toObject();
  }
  const res = await applyStkResult(attempt._id, tenantId, { checkoutRequestId: attempt.checkoutRequestId, merchantRequestId: attempt.merchantRequestId ?? '', resultCode: q.resultCode ?? -1, resultDesc: q.resultDesc ?? '' }, 'query');
  return res.attempt.toObject();
}

export async function cancelAttempt(ctx: BranchContext, attemptId: string) {
  const a = await PaymentAttempt.findOneAndUpdate(
    { tenantId: ctx.tenantId, branchId: ctx.branchId, _id: attemptId, status: { $in: ['initiated', 'pending'] } },
    { $set: { status: 'cancelled', resultDesc: 'Cancelled at POS (a late successful callback will still be recorded)' } },
    { new: true },
  );
  if (!a) throw notFound('Pending attempt');
  emitBranch(ctx.tenantId, ctx.branchId, 'payment.updated', { orderId: String(a.orderId), attemptId: String(a._id), status: a.status });
  return a;
}

// ───────────────────────────── Refunds ─────────────────────────────

export async function refundPayment(ctx: BranchContext, paymentId: string, input: { amount: number; reason: string; restock: boolean; reference?: string; idempotencyKey: string; approval?: ApprovalInput }) {
  const approvedBy = await resolveApproval(ctx, P.PAYMENTS_REFUND, input.approval, 'Refunds');
  const dup = await Refund.findOne({ tenantId: ctx.tenantId, idempotencyKey: input.idempotencyKey }).lean();
  if (dup) return dup;
  const refund = await withTransaction(async (session) => {
    const payment = await Payment.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: paymentId }).session(session);
    if (!payment) throw notFound('Payment');
    const refundable = payment.amount - (payment.refundedAmount ?? 0);
    if (input.amount <= 0 || input.amount > refundable) throw badRequest(`Refundable amount is ${toMajor(refundable).toFixed(2)}`);
    if (payment.method === 'mpesa' && !input.reference) {
      throw badRequest('Reverse the M-Pesa transaction on the M-Pesa org portal first, then enter the reversal reference. Automated Daraja reversals require initiator credentials and are not enabled.');
    }
    if (payment.method === 'cash') {
      const { drawer: cs, mode } = await findOpenDrawer(ctx, session);
      if (!cs) throw new AppError(409, 'NO_CASH_SESSION', noDrawerMessage(mode, 'to pay out a cash refund'));
    }
    const [refund] = await Refund.create(
      [{ tenantId: ctx.tenantId, branchId: ctx.branchId, orderId: payment.orderId, paymentId: payment._id, method: payment.method, amount: input.amount, reason: input.reason, status: 'completed', reference: input.reference, requestedBy: ctx.userId, approvedBy, restock: input.restock, idempotencyKey: input.idempotencyKey }],
      { session },
    );
    payment.refundedAmount = (payment.refundedAmount ?? 0) + input.amount;
    await payment.save({ session });
    if (payment.method === 'account' && payment.customerId) {
      await Customer.updateOne({ tenantId: ctx.tenantId, _id: payment.customerId }, { $inc: { 'credit.balance': -input.amount } }, { session });
    }
    const order = await Order.findOne({ tenantId: ctx.tenantId, _id: payment.orderId }).session(session);
    if (order) {
      order.totals!.refunded = (order.totals!.refunded ?? 0) + input.amount;
      order.paymentStatus = order.totals!.refunded >= order.totals!.paid ? 'refunded' : 'partially_refunded';
      if (input.restock && order.stockDeducted) {
        // Reverse ingredient consumption proportionally to the refunded share.
        const share = Math.min(1, input.amount / Math.max(1, order.totals!.total));
        const versions = await RecipeVersion.find({ tenantId: ctx.tenantId, _id: { $in: order.items.map((i) => i.recipeVersionId).filter(Boolean) } }).session(session).lean();
        for (const line of order.items) {
          const v = versions.find((x) => String(x._id) === String(line.recipeVersionId));
          if (line.voided || !v) continue;
          for (const need of requirements(v as never, line.qty * share)) {
            await postMovement({ tenantId: ctx.tenantId, branchId: ctx.branchId, ingredientId: need.ingredientId, type: 'sale_reversal', qty: need.qty, idempotencyKey: `refund:${refund._id}:${line.lineId}:${need.ingredientId}`, refType: 'Refund', refId: refund._id, by: ctx.userId, reason: input.reason }, session);
          }
        }
      }
      await order.save({ session });
    }
    return refund;
  });
  await audit(ctx, { action: 'payment.refund', entity: 'Payment', entityId: paymentId, reason: input.reason, approvedBy, meta: { amount: input.amount, restock: input.restock, reference: input.reference } });
  return refund;
}

/** Structured receipt used by the print bridge, browser printing and email. */
export async function buildReceipt(tenantId: Types.ObjectId, orderId: Types.ObjectId | string): Promise<ReceiptData> {
  const order = await Order.findOne({ tenantId, _id: orderId }).lean();
  if (!order) throw notFound('Order');
  const [tenant, branch, payments, cashier] = await Promise.all([
    Tenant.findById(tenantId).lean(),
    Branch.findOne({ tenantId, _id: order.branchId }).lean(),
    Payment.find({ tenantId, orderId: order._id }).sort({ receivedAt: 1 }).lean(),
    order.cashierId ? User.findOne({ tenantId, _id: order.cashierId }, { name: 1 }).lean() : null,
  ]);
  const lines = order.items.filter((i) => !i.voided).map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice, total: i.lineTotal, modifiers: i.modifiers.map((m) => m.name ?? '').filter(Boolean), complimentary: !!i.complimentary }));
  return {
    business: { name: tenant?.name, kraPin: tenant?.kraPin, header: tenant?.branding?.receiptHeader, footer: tenant?.branding?.receiptFooter, logoUrl: tenant?.branding?.logoUrl, timezone: tenant?.settings?.timezone },
    branch: { name: branch?.name, address: branch?.address, phone: branch?.phone },
    order: { number: order.number, receiptNumber: order.receiptNumber, type: order.type, table: order.tableNumber, waiter: order.waiterName, cashier: cashier?.name, customer: order.customerName, guests: order.guests, createdAt: (order as { createdAt?: Date }).createdAt, paidAt: order.paidAt, status: order.status, offline: order.source === 'offline' },
    lines,
    totals: order.totals,
    taxes: order.taxBreakdown,
    payments: payments.map((p) => ({ method: p.method, amount: p.amount, tendered: p.tendered, change: p.change, reference: p.reference, phone: p.phone })),
  };
}

export function receiptText(r: ReceiptData, copy: 'original' | 'duplicate' = 'original') {
  return docToText(receiptDoc(r, copy));
}

