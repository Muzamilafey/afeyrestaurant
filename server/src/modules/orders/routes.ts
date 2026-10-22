import { z } from 'zod';
import { createModule, zId, zMoney } from '../../http/route';
import { Order, Payment, PaymentAttempt, Receipt, Refund, Customer } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import * as svc from '../../services/orders';
import * as pay from '../../services/payments';
import { zApproval } from '../../services/approval';
import { audit } from '../../services/audit';
import { notify } from '../../services/notify';
import { badRequest, notFound } from '../../lib/errors';
import { toMajor } from '../../lib/money';

const m = createModule('/orders', 'Orders');

const zItem = z.object({
  productId: zId, qty: z.number().positive().max(999), variant: z.string().max(40).optional(),
  modifiers: z.array(z.object({ groupId: zId, optionId: zId })).max(30).optional(), notes: z.string().max(300).optional(),
  lineId: z.uuid().optional(), priority: z.boolean().optional(), ageCheckConfirmed: z.boolean().optional(),
});
const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery', 'room_service', 'bar_counter', 'online'] as const;

m.route(
  { method: 'get', path: '', summary: 'List orders for the active branch', permission: P.ORDERS_VIEW, query: z.object({ status: z.string().optional(), active: z.coerce.boolean().optional(), tableId: zId.optional(), type: z.string().optional(), q: z.string().max(40).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) },
  async ({ ctx, query }) => {
    const f: Record<string, unknown> = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    if (query.active) f.status = { $in: ['open', 'held'] };
    else if (query.status) f.status = { $in: query.status.split(',') };
    if (query.tableId) f.tableId = query.tableId;
    if (query.type) f.type = query.type;
    if (query.q) f.$or = [{ number: { $regex: query.q.replace(/[^\w-]/g, ''), $options: 'i' } }, { customerPhone: query.q.replace(/\D/g, '') || '__none__' }, { receiptNumber: query.q }];
    if (query.from || query.to) f.createdAt = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
    return Order.find(f).sort({ createdAt: -1 }).limit(query.limit).lean();
  },
);

m.route({ method: 'get', path: '/:id', summary: 'Order with payments and attempts', permission: P.ORDERS_VIEW }, async ({ ctx, params }) => {
  const order = await svc.loadOrder(ctx, params.id);
  const [payments, attempts, refunds] = await Promise.all([
    Payment.find({ tenantId: ctx.tenantId, orderId: order._id }).sort({ createdAt: 1 }).lean(),
    PaymentAttempt.find({ tenantId: ctx.tenantId, orderId: order._id }, { callbackTokenHash: 0 }).sort({ createdAt: -1 }).limit(20).lean(),
    Refund.find({ tenantId: ctx.tenantId, orderId: order._id }).lean(),
  ]);
  return { order, payments, attempts, refunds };
});

m.route(
  {
    method: 'post', path: '', summary: 'Create an order (idempotent by clientId)', permission: P.ORDERS_CREATE,
    body: z.object({
      clientId: z.uuid().optional(), type: z.enum(ORDER_TYPES), tableId: zId.optional(), guests: z.number().int().min(1).max(100).optional(),
      customerId: zId.optional(), customerName: z.string().max(80).optional(), customerPhone: z.string().max(20).optional(), notes: z.string().max(500).optional(), priority: z.boolean().optional(),
      items: z.array(zItem).max(100).optional(), delivery: z.object({ address: z.string().min(3).max(300), landmark: z.string().max(200).optional(), contactPhone: z.string().max(20).optional(), zoneId: zId.optional() }).optional(),
      approval: zApproval, overrideStockReason: z.string().max(200).optional(), sendToStations: z.boolean().optional(),
    }),
  },
  async ({ ctx, body, res }) => {
    const { order, duplicate } = await svc.createOrder(ctx, body);
    res.status(duplicate ? 200 : 201);
    if (body.sendToStations && !duplicate) return (await svc.sendToStations(ctx, String(order._id), `create:${order.clientId}`)).order;
    return order;
  },
);

m.route({ method: 'post', path: '/:id/items', summary: 'Add items (idempotent by lineId)', permission: P.ORDERS_UPDATE, body: z.object({ items: z.array(zItem).min(1).max(100), approval: zApproval, overrideStockReason: z.string().max(200).optional() }) }, async ({ ctx, params, body }) => svc.addItems(ctx, params.id, body.items, body));
m.route({ method: 'patch', path: '/:id/items/:lineId', summary: 'Change quantity/notes of an unsent item', permission: P.ORDERS_UPDATE, body: z.object({ qty: z.number().positive().max(999).optional(), notes: z.string().max(300).optional() }) }, async ({ ctx, params, body }) => svc.updateItem(ctx, params.id, params.lineId, body));
m.route({ method: 'post', path: '/:id/items/:lineId/void', summary: 'Void an item (reason + approval for sent items)', permission: P.ORDERS_UPDATE, body: z.object({ reason: z.string().min(3).max(200), approval: zApproval }) }, async ({ ctx, params, body }) => svc.voidItem(ctx, params.id, params.lineId, body.reason, body.approval));
m.route({ method: 'post', path: '/:id/items/:lineId/complimentary', summary: 'Mark an item complimentary (manager approval)', permission: P.ORDERS_UPDATE, body: z.object({ reason: z.string().min(3).max(200), approval: zApproval }) }, async ({ ctx, params, body }) => svc.complimentaryItem(ctx, params.id, params.lineId, body.reason, body.approval));
m.route({ method: 'post', path: '/:id/discount', summary: 'Apply/remove an order discount or coupon', permission: P.ORDERS_UPDATE, body: z.object({ type: z.enum(['percent', 'amount', 'none']), value: z.number().min(0), reason: z.string().max(200).optional(), couponCode: z.string().max(30).optional(), approval: zApproval }) }, async ({ ctx, params, body }) => svc.applyDiscount(ctx, params.id, body, body.approval));
m.route({ method: 'post', path: '/:id/send', summary: 'Send new items to kitchen/bar (idempotent by submissionKey)', permission: P.ORDERS_UPDATE, body: z.object({ submissionKey: z.string().min(8).max(64).optional() }) }, async ({ ctx, params, body }) => svc.sendToStations(ctx, params.id, body.submissionKey));
m.route({ method: 'post', path: '/:id/hold', summary: 'Hold an order', permission: P.ORDERS_UPDATE }, async ({ ctx, params }) => svc.setHold(ctx, params.id, true));
m.route({ method: 'post', path: '/:id/resume', summary: 'Retrieve a held order', permission: P.ORDERS_UPDATE }, async ({ ctx, params }) => svc.setHold(ctx, params.id, false));
m.route({ method: 'post', path: '/:id/transfer', summary: 'Transfer to another table', permission: P.ORDERS_TRANSFER, body: z.object({ tableId: zId }) }, async ({ ctx, params, body }) => svc.transferTable(ctx, params.id, body.tableId));
m.route({ method: 'post', path: '/:id/merge', summary: 'Merge another order into this one', permission: P.ORDERS_MERGE, body: z.object({ sourceOrderId: zId }) }, async ({ ctx, params, body }) => svc.mergeOrders(ctx, params.id, body.sourceOrderId));
m.route({ method: 'post', path: '/:id/split', summary: 'Split selected items into a new bill', permission: P.ORDERS_UPDATE, body: z.object({ lines: z.array(z.object({ lineId: z.string(), qty: z.number().positive().optional() })).min(1), toTableId: zId.optional() }) }, async ({ ctx, params, body }) => svc.splitOrder(ctx, params.id, body.lines, body.toTableId));
m.route({ method: 'post', path: '/:id/void', summary: 'Void an unpaid order', permission: P.ORDERS_UPDATE, body: z.object({ reason: z.string().min(3).max(200), approval: zApproval }) }, async ({ ctx, params, body }) => svc.voidOrder(ctx, params.id, body.reason, body.approval));
m.route({ method: 'patch', path: '/:id', summary: 'Update order header (customer, guests, notes, priority)', permission: P.ORDERS_UPDATE, body: z.object({ customerId: zId.nullable().optional(), customerName: z.string().max(80).optional(), customerPhone: z.string().max(20).optional(), guests: z.number().int().min(1).max(100).optional(), notes: z.string().max(500).optional(), priority: z.boolean().optional() }) }, async ({ ctx, params, body }) => {
  let customer = null;
  if (body.customerId) {
    customer = await Customer.findOne({ tenantId: ctx.tenantId, _id: body.customerId }).lean();
    if (!customer) throw notFound('Customer');
  }
  return svc.mutateOrder(ctx, params.id, async (o) => {
    if (body.customerId === null) o.customerId = undefined;
    if (customer) {
      o.customerId = customer._id;
      o.customerName = customer.name;
      o.customerPhone = customer.phone ?? undefined;
    }
    if (body.customerName !== undefined) o.customerName = body.customerName;
    if (body.customerPhone !== undefined) o.customerPhone = body.customerPhone;
    if (body.guests) o.guests = body.guests;
    if (body.notes !== undefined) o.notes = body.notes;
    if (body.priority !== undefined) o.priority = body.priority;
  });
});

// ── Payments ──
m.route(
  { method: 'post', path: '/:id/payments', summary: 'Record a cash/card/QR/account payment or manager-confirmed M-Pesa code', permission: P.PAYMENTS_RECEIVE, body: z.object({ method: z.enum(['cash', 'card', 'qr', 'account', 'mpesa_manual']), amount: zMoney, tendered: zMoney.optional(), reference: z.string().max(40).optional(), customerId: zId.optional(), reason: z.string().max(200).optional(), idempotencyKey: z.string().min(8).max(80), approval: zApproval }) },
  async ({ ctx, params, body, res }) => {
    const r = await pay.recordPayment(ctx, params.id, body);
    res.status(r.duplicate ? 200 : 201);
    return r;
  },
);
m.route({ method: 'post', path: '/:id/mpesa', summary: 'Send an M-Pesa STK Push prompt', permission: P.PAYMENTS_RECEIVE, feature: 'mpesa', body: z.object({ phone: z.string().min(9).max(16), amount: zMoney, idempotencyKey: z.string().min(8).max(80) }) }, async ({ ctx, params, body }) => pay.initiateMpesa(ctx, params.id, body));
m.route({ method: 'get', path: '/:id/mpesa/:attemptId', summary: 'Check/refresh an M-Pesa attempt status', permission: P.PAYMENTS_RECEIVE }, async ({ ctx, params }) => {
  const a = await PaymentAttempt.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, orderId: params.id, _id: params.attemptId }).lean();
  if (!a) throw notFound('Payment attempt');
  const res = await pay.queryAttempt(ctx.tenantId, a._id).catch(() => a);
  const { callbackTokenHash: _h, ...safe } = res as Record<string, unknown>;
  return safe;
});
m.route({ method: 'post', path: '/:id/mpesa/:attemptId/cancel', summary: 'Stop waiting for an M-Pesa prompt', permission: P.PAYMENTS_RECEIVE }, async ({ ctx, params }) => pay.cancelAttempt(ctx, params.attemptId));
m.route({ method: 'post', path: '/payments/:paymentId/refund', summary: 'Refund a payment (reason + manager approval)', permission: P.PAYMENTS_RECEIVE, body: z.object({ amount: zMoney, reason: z.string().min(3).max(200), restock: z.boolean().default(false), reference: z.string().max(40).optional(), idempotencyKey: z.string().min(8).max(80), approval: zApproval }) }, async ({ ctx, params, body }) => pay.refundPayment(ctx, params.paymentId, body));

// ── Receipts & bills ──
m.route({ method: 'get', path: '/:id/receipt', summary: 'Structured receipt or preliminary bill', permission: P.ORDERS_VIEW }, async ({ ctx, params }) => {
  const order = await svc.loadOrder(ctx, params.id);
  const r = await pay.buildReceipt(ctx.tenantId, order._id);
  const rec = await Receipt.findOne({ tenantId: ctx.tenantId, orderId: order._id, kind: 'receipt' }).lean();
  return { receipt: r, text: pay.receiptText(r), printCount: rec?.printCount ?? 0 };
});
/**
 * Register a print of a receipt. The first successful print is the ORIGINAL; any later print is a DUPLICATE COPY
 * and requires receipts.reprint with a reason.
 */
m.route({ method: 'post', path: '/:id/receipt/print', summary: 'Record a receipt print (original vs duplicate)', permission: P.ORDERS_VIEW, body: z.object({ printer: z.string().max(60).optional(), status: z.enum(['printed', 'failed']).default('printed'), error: z.string().max(300).optional(), reason: z.string().max(200).optional() }) }, async ({ ctx, params, body, req }) => {
  const order = await svc.loadOrder(ctx, params.id);
  if (order.status !== 'paid') throw badRequest('Receipts are only issued for paid orders. Print a bill instead.');
  const rec = await Receipt.findOne({ tenantId: ctx.tenantId, orderId: order._id, kind: 'receipt' });
  if (!rec) throw notFound('Receipt');
  const copy = rec.printCount > 0 ? 'duplicate' : 'original';
  if (copy === 'duplicate' && body.status === 'printed') {
    if (!ctx.permissions.has(P.RECEIPTS_REPRINT)) throw badRequest('Reprinting requires the receipts.reprint permission');
    if (!body.reason) throw badRequest('A reason is required to reprint a receipt');
  }
  rec.prints.push({ at: new Date(), by: ctx.userId, copy, printer: body.printer, status: body.status, error: body.error, reason: body.reason });
  if (body.status === 'printed') rec.printCount += 1;
  await rec.save();
  if (copy === 'duplicate' && body.status === 'printed') await audit(ctx, { action: 'receipt.reprint', entity: 'Order', entityId: order._id, reason: body.reason }, req);
  const r = await pay.buildReceipt(ctx.tenantId, order._id);
  return { copy, text: pay.receiptText(r, copy), receipt: r };
});
m.route({ method: 'post', path: '/:id/receipt/send', summary: 'Send the receipt by SMS or email', permission: P.ORDERS_VIEW, body: z.object({ channel: z.enum(['sms', 'email']), to: z.string().min(5).max(120) }) }, async ({ ctx, params, body }) => {
  const order = await svc.loadOrder(ctx, params.id);
  if (order.status !== 'paid') throw badRequest('Order is not paid');
  const r = await pay.buildReceipt(ctx.tenantId, order._id);
  const payments = r.payments.map((p) => (p.method === 'mpesa' ? 'M-Pesa' : p.method)).join(' + ');
  return notify(ctx.tenantId, {
    event: body.channel === 'sms' ? 'payment_confirmation' : 'receipt', channel: body.channel, to: body.to,
    vars: { order_number: order.number, amount: toMajor(order.totals!.total).toFixed(2), payment_method: payments, receipt_number: order.receiptNumber, receipt_text: pay.receiptText(r), customer_name: order.customerName },
    dedupeKey: `receipt:${order._id}:${body.channel}:${body.to}`, refType: 'Order', refId: order._id,
  });
});

export default m;
