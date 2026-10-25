import { randomUUID, createHash } from 'node:crypto';
import mongoose, { Types, type ClientSession } from 'mongoose';
import { Order, type OrderDoc, Product, Category, ModifierGroup, TaxRate, Branch, Tenant, Table, KitchenTicket, Customer, Coupon, Printer, PrintJob, Rider } from '../models';
import type { BranchContext } from '../http/context';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { PERMISSIONS as P } from '../auth/permissions';
import { computeTotals, localParts, resolvePrice, inWindow } from './pricing';
import { checkAvailability, getCurrentRecipeVersion, requirements } from './inventory';
import { resolveApproval, type ApprovalInput } from './approval';
import { audit } from './audit';
import { nextNumber } from './counters';
import { emitBranch, emitStation } from '../realtime/bus';
import { bpsOf } from '../lib/money';
import { normalizeKePhone } from '../lib/phone';

export interface ItemInput {
  productId: string;
  qty: number;
  variant?: string;
  modifiers?: Array<{ groupId: string; optionId: string }>;
  notes?: string;
  lineId?: string;
  priority?: boolean;
  ageCheckConfirmed?: boolean;
}

const OPEN = ['open', 'held'];

export async function loadOrder(ctx: BranchContext, id: string, session?: ClientSession) {
  if (!Types.ObjectId.isValid(id)) throw notFound('Order');
  const order = await Order.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: id }).session(session ?? null);
  if (!order) throw notFound('Order');
  return order;
}

/** Load → mutate → save with optimistic concurrency, retrying when another terminal updated the order meanwhile. */
export async function mutateOrder(ctx: BranchContext, id: string, fn: (o: OrderDoc) => Promise<void>, opts: { allowClosed?: boolean } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const order = await loadOrder(ctx, id);
    if (!opts.allowClosed && !OPEN.includes(order.status)) throw conflict(`Order ${order.number} is ${order.status} and can no longer be changed`, 'ORDER_LOCKED');
    await fn(order);
    try {
      await order.save();
      broadcastOrder(order);
      return order;
    } catch (e) {
      if (e instanceof mongoose.Error.VersionError && attempt < 3) continue;
      if (e instanceof mongoose.Error.VersionError) throw conflict('This order was changed on another terminal. Refresh and try again.', 'ORDER_CONFLICT');
      throw e;
    }
  }
  throw conflict('Could not update order', 'ORDER_CONFLICT');
}

export function broadcastOrder(order: OrderDoc) {
  emitBranch(order.tenantId, order.branchId, 'order.updated', { id: String(order._id), number: order.number, status: order.status, paymentStatus: order.paymentStatus, tableId: order.tableId ? String(order.tableId) : null });
}

/** Recalculate all totals on the order document. */
export async function recalc(order: OrderDoc, session?: ClientSession) {
  const [branch, taxes] = await Promise.all([
    Branch.findOne({ tenantId: order.tenantId, _id: order.branchId }).session(session ?? null).lean(),
    TaxRate.find({ tenantId: order.tenantId, active: true }).session(session ?? null).lean(),
  ]);
  const scModes = branch?.settings?.serviceChargeModes ?? ['dine_in'];
  const deliveryFee = order.type === 'delivery' ? order.totals?.deliveryFee ?? 0 : 0;
  const t = computeTotals({
    items: order.items.map((i) => ({ qty: i.qty, unitPrice: i.unitPrice, discount: i.discount, voided: i.voided, complimentary: i.complimentary, serviceChargeApplies: i.serviceChargeApplies, taxRateIds: i.taxRateIds as Types.ObjectId[] })),
    orderDiscount: { type: (order.discount?.type ?? 'none') as 'percent' | 'amount' | 'none', value: order.discount?.value ?? 0 },
    serviceChargeBps: branch?.settings?.serviceChargeBps ?? 0,
    serviceChargeEligible: scModes.includes(order.type),
    deliveryFee,
    taxes: taxes.map((x) => ({ _id: x._id, code: x.code, rateBps: x.rateBps, inclusive: x.inclusive })),
  });
  order.items.forEach((it, i) => {
    it.lineTotal = t.lines[i].lineTotal;
    it.taxes = t.lines[i].taxes as never;
  });
  order.set('discount.amount', t.discount);
  order.set('totals', {
    ...(order.totals ?? {}),
    subtotal: t.subtotal, discount: t.discount, serviceCharge: t.serviceCharge, taxInclusive: t.taxInclusive, taxExclusive: t.taxExclusive,
    deliveryFee: t.deliveryFee, total: t.total, paid: order.totals?.paid ?? 0, refunded: order.totals?.refunded ?? 0,
    balance: t.total - (order.totals?.paid ?? 0),
  });
  order.set('taxBreakdown', t.breakdown);
}

/** Build order lines from product selections: validates availability, modifiers, age restrictions and stock. */
/**
 * opts.offline: replaying a sale that already happened offline. Availability, schedule, age and stock checks
 * were the terminal's responsibility at the time; they are recorded but cannot block the sync.
 */
async function buildLines(ctx: BranchContext, items: ItemInput[], opts: { approval?: ApprovalInput; overrideStockReason?: string; offline?: boolean }) {
  const tenant = await Tenant.findById(ctx.tenantId).lean();
  const branch = await Branch.findOne({ tenantId: ctx.tenantId, _id: ctx.branchId }).lean();
  const now = localParts(tenant?.settings?.timezone ?? 'Africa/Nairobi');
  const productIds = [...new Set(items.map((i) => i.productId))];
  if (productIds.some((id) => !Types.ObjectId.isValid(id))) throw badRequest('Invalid product id');
  await Product.updateMany({ tenantId: ctx.tenantId, _id: { $in: productIds }, status: 'sold_out', soldOutUntil: { $lte: new Date() } }, { $set: { status: 'available' }, $unset: { soldOutUntil: 1, soldOutBy: 1, soldOutAt: 1 } });
  const products = await Product.find({ tenantId: ctx.tenantId, _id: { $in: productIds } }).lean();
  const categories = await Category.find({ tenantId: ctx.tenantId, _id: { $in: products.map((p) => p.categoryId) } }).lean();
  const groupIds = products.flatMap((p) => p.modifierGroupIds ?? []);
  const groups = await ModifierGroup.find({ tenantId: ctx.tenantId, _id: { $in: groupIds } }).lean();

  const lines = [];
  const needs: Array<{ ingredientId: Types.ObjectId; qty: number }> = [];
  for (const it of items) {
    const p = products.find((x) => String(x._id) === it.productId);
    if (!p) throw notFound('Product');
    if (!opts.offline && p.status !== 'available') throw conflict(`${p.name} is ${p.status === 'sold_out' ? 'sold out' : 'not available'}`, 'PRODUCT_UNAVAILABLE');
    const av = p.availability;
    if (!opts.offline && av?.branchIds?.length && !av.branchIds.some((b) => String(b) === String(ctx.branchId))) throw conflict(`${p.name} is not sold at this branch`, 'PRODUCT_UNAVAILABLE');
    if (!opts.offline && ((av?.days?.length && !av.days.includes(now.day)) || !inWindow(now.time, av?.start, av?.end))) throw conflict(`${p.name} is not available at this time`, 'PRODUCT_UNAVAILABLE');
    if (!opts.offline && p.ageRestricted && !it.ageCheckConfirmed) throw new AppError(422, 'AGE_CHECK_REQUIRED', `${p.name} is age-restricted. Confirm the customer is 18 or older.`);
    const price = resolvePrice(p, { branchId: ctx.branchId, variant: it.variant, happyHours: branch?.settings?.happyHours as never, now });
    if ('error' in price) throw badRequest(price.error as string);

    // Validate modifiers against the product's groups and min/max rules.
    const chosen = (it.modifiers ?? []).map((m) => {
      const g = groups.find((x) => String(x._id) === m.groupId && (p.modifierGroupIds ?? []).some((id) => String(id) === m.groupId));
      const o = g?.options.find((x) => String((x as { _id?: Types.ObjectId })._id) === m.optionId && x.active !== false);
      if (!g || !o) throw badRequest(`Invalid modifier for ${p.name}`);
      return { groupId: String(g._id), groupName: g.name, name: o.name, priceDelta: o.priceDelta ?? 0 };
    });
    for (const gid of p.modifierGroupIds ?? []) {
      const g = groups.find((x) => String(x._id) === String(gid));
      if (!g) continue;
      const n = chosen.filter((c) => c.groupId === String(gid)).length;
      if (n < (g.minSelect ?? 0)) throw badRequest(`Choose at least ${g.minSelect} option(s) for "${g.name}" on ${p.name}`);
      if (n > (g.maxSelect ?? 1)) throw badRequest(`Choose at most ${g.maxSelect} option(s) for "${g.name}" on ${p.name}`);
    }
    const cat = categories.find((c) => String(c._id) === String(p.categoryId));
    const station = (p.station && p.station !== 'inherit' ? p.station : cat?.station ?? 'kitchen') as 'kitchen' | 'bar' | 'none';
    const rv = await getCurrentRecipeVersion(ctx.tenantId, p._id, price.variantName ?? '');
    if (rv) needs.push(...requirements(rv as never, it.qty));
    lines.push({
      lineId: it.lineId ?? randomUUID(),
      productId: p._id,
      name: price.variantName ? `${p.name} (${price.variantName})` : p.name,
      categoryId: p.categoryId,
      station,
      qty: it.qty,
      unitPrice: price.price + chosen.reduce((s, c) => s + c.priceDelta, 0),
      modifiers: chosen.map(({ groupName, name, priceDelta }) => ({ groupName, name, priceDelta })),
      variant: price.variantName,
      notes: it.notes,
      discount: 0,
      lineTotal: 0,
      serviceChargeApplies: p.serviceChargeApplies !== false,
      taxRateIds: p.taxRateIds ?? [],
      ageRestricted: !!p.ageRestricted,
      ageCheckConfirmed: p.ageRestricted ? true : undefined,
      recipeVersionId: rv?._id,
      status: 'new',
      priority: !!it.priority,
      addedBy: ctx.userId,
      happyHour: price.happyHour,
    });
  }
  // Ingredient availability: insufficient stock blocks the sale unless an authorised override is given.
  const shortages = opts.offline ? [] : await checkAvailability(ctx.tenantId, ctx.branchId, needs);
  let override: { by: Types.ObjectId; reason: string } | undefined;
  if (opts.offline) override = { by: ctx.userId, reason: 'Offline sale synchronised' };
  if (shortages.length) {
    if (!opts.overrideStockReason) throw conflict('Insufficient ingredients for this order', 'INSUFFICIENT_STOCK', { shortages });
    const by = await resolveApproval(ctx, P.INVENTORY_OVERRIDE, opts.approval, 'Selling without sufficient stock');
    override = { by, reason: opts.overrideStockReason };
    await audit(ctx, { action: 'inventory.override_sale', reason: opts.overrideStockReason, approvedBy: by, meta: { shortages } });
  }
  if (override) for (const l of lines) (l as Record<string, unknown>).stockOverride = override;
  return lines;
}

export interface CreateOrderInput {
  clientId?: string;
  type: 'dine_in' | 'takeaway' | 'delivery' | 'room_service' | 'bar_counter' | 'online';
  outlet?: 'restaurant' | 'bar';
  tableId?: string;
  guests?: number;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  priority?: boolean;
  items?: ItemInput[];
  delivery?: { address: string; landmark?: string; contactPhone?: string; zoneId?: string; riderId?: string };
  approval?: ApprovalInput;
  overrideStockReason?: string;
}

export async function createOrder(ctx: BranchContext, input: CreateOrderInput) {
  const clientId = input.clientId ?? randomUUID();
  // Idempotency: resubmitting the same clientId returns the existing order instead of creating a duplicate.
  const existing = await Order.findOne({ tenantId: ctx.tenantId, clientId });
  if (existing) return { order: existing, duplicate: true };

  const branch = await Branch.findOne({ tenantId: ctx.tenantId, _id: ctx.branchId }).lean();
  if (!branch) throw notFound('Branch');
  const enabled = branch.settings?.enabledModes ?? [];
  if (input.type === 'room_service' && !branch.settings?.roomServiceEnabled) throw badRequest('Room service is not enabled for this branch');
  if (!enabled.includes(input.type) && input.type !== 'room_service') throw badRequest(`${input.type.replace('_', ' ')} orders are not enabled for this branch`);

  let table = null;
  if (input.type === 'dine_in') {
    if (!input.tableId) throw badRequest('Select a table for dine-in orders');
    table = await Table.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: input.tableId, active: true });
    if (!table) throw notFound('Table');
  }
  let customer = null;
  if (input.customerId) {
    customer = await Customer.findOne({ tenantId: ctx.tenantId, _id: input.customerId }).lean();
    if (!customer) throw notFound('Customer');
  }
  if (input.type === 'delivery' && !input.delivery?.address) throw badRequest('Delivery address is required');
  // A delivery rider can be chosen while placing the order (any active rider of this branch).
  const rider = input.type === 'delivery' && input.delivery?.riderId ? await Rider.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: input.delivery.riderId, active: true }).lean() : null;
  if (input.delivery?.riderId && input.type === 'delivery' && !rider) throw badRequest('That delivery rider is not available');
  const lines = input.items?.length ? await buildLines(ctx, input.items, input) : [];
  const number = await nextNumber(ctx.tenantId, branch.settings?.orderPrefix ?? 'ORD', branch.code);
  const phone = input.customerPhone ? normalizeKePhone(input.customerPhone) ?? undefined : customer?.phone ?? undefined;
  const order = new Order({
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    number,
    clientId,
    type: input.type,
    outlet: input.outlet ?? (input.type === 'bar_counter' ? 'bar' : 'restaurant'),
    tableId: table?._id,
    tableNumber: table?.number,
    guests: input.guests ?? 1,
    waiterId: ctx.userId,
    waiterName: ctx.userName,
    customerId: customer?._id,
    customerName: input.customerName ?? customer?.name,
    customerPhone: phone,
    notes: input.notes,
    priority: !!input.priority,
    items: lines,
    delivery: input.type === 'delivery' ? { ...input.delivery, riderId: rider?._id, riderName: rider?.name, status: rider ? 'assigned' : 'pending', assignedAt: rider ? new Date() : undefined, trackingCode: randomUUID().slice(0, 8).toUpperCase() } : undefined,
    totals: { deliveryFee: input.type === 'delivery' ? branch.settings?.deliveryFee ?? 0 : 0 },
  });
  await recalc(order);
  try {
    await order.save();
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const dup = await Order.findOne({ tenantId: ctx.tenantId, clientId });
      if (dup) return { order: dup, duplicate: true };
    }
    throw e;
  }
  if (table && table.status !== 'occupied') {
    await Table.updateOne({ tenantId: ctx.tenantId, _id: table._id }, { $set: { status: 'occupied', occupiedSince: new Date(), waiterId: ctx.userId } });
    emitBranch(ctx.tenantId, ctx.branchId, 'table.updated', { id: String(table._id) });
  }
  broadcastOrder(order);
  return { order, duplicate: false };
}

export async function addItems(ctx: BranchContext, orderId: string, items: ItemInput[], opts: { approval?: ApprovalInput; overrideStockReason?: string }) {
  const lines = await buildLines(ctx, items, opts);
  return mutateOrder(ctx, orderId, async (o) => {
    const existing = new Set(o.items.map((i) => i.lineId));
    for (const l of lines) if (!existing.has(l.lineId)) o.items.push(l as never); // lineId makes retries idempotent
    await recalc(o);
  });
}

export async function updateItem(ctx: BranchContext, orderId: string, lineId: string, patch: { qty?: number; notes?: string }) {
  return mutateOrder(ctx, orderId, async (o) => {
    const line = o.items.find((i) => i.lineId === lineId);
    if (!line || line.voided) throw notFound('Order line');
    if (line.status !== 'new') throw conflict('This item was already sent to the kitchen/bar. Void it instead.', 'ITEM_SENT');
    if (patch.qty !== undefined) line.qty = patch.qty;
    if (patch.notes !== undefined) line.notes = patch.notes;
    await recalc(o);
  });
}

export async function voidItem(ctx: BranchContext, orderId: string, lineId: string, reason: string, approval?: ApprovalInput) {
  let approvedBy: Types.ObjectId | undefined;
  const order = await mutateOrder(ctx, orderId, async (o) => {
    const line = o.items.find((i) => i.lineId === lineId);
    if (!line || line.voided) throw notFound('Order line');
    const sent = line.status !== 'new';
    approvedBy = await resolveApproval(ctx, sent ? P.ORDERS_VOID_SENT_ITEM : P.ORDERS_VOID_ITEM, approval, sent ? 'Voiding an item already sent to the kitchen/bar' : 'Voiding an item');
    line.voided = true;
    line.voidReason = reason;
    line.voidedBy = ctx.userId;
    line.approvedBy = approvedBy;
    if (sent) line.status = 'cancelled';
    await recalc(o);
  });
  const line = order.items.find((i) => i.lineId === lineId)!;
  if (line.ticketId) {
    await KitchenTicket.updateOne({ tenantId: ctx.tenantId, _id: line.ticketId, 'items.lineId': lineId }, { $set: { 'items.$.status': 'cancelled' } });
    emitStation(ctx.tenantId, ctx.branchId, line.station, 'ticket.updated', { id: String(line.ticketId) });
  }
  await audit(ctx, { action: 'order.void_item', entity: 'Order', entityId: order._id, reason, approvedBy, meta: { lineId, name: line.name, qty: line.qty, amount: line.qty * line.unitPrice } });
  return order;
}

export async function complimentaryItem(ctx: BranchContext, orderId: string, lineId: string, reason: string, approval?: ApprovalInput) {
  const approvedBy = await resolveApproval(ctx, P.ORDERS_COMPLIMENTARY, approval, 'Complimentary items');
  const order = await mutateOrder(ctx, orderId, async (o) => {
    const line = o.items.find((i) => i.lineId === lineId && !i.voided);
    if (!line) throw notFound('Order line');
    line.complimentary = true;
    line.approvedBy = approvedBy;
    line.voidReason = reason;
    await recalc(o);
  });
  await audit(ctx, { action: 'order.complimentary', entity: 'Order', entityId: order._id, reason, approvedBy, meta: { lineId } });
  return order;
}

export async function applyDiscount(ctx: BranchContext, orderId: string, d: { type: 'percent' | 'amount' | 'none'; value: number; reason?: string; couponCode?: string }, approval?: ApprovalInput) {
  const tenant = await Tenant.findById(ctx.tenantId).lean();
  let approvedBy: Types.ObjectId | undefined;
  let coupon = null;
  if (d.couponCode) {
    coupon = await Coupon.findOne({ tenantId: ctx.tenantId, code: d.couponCode.toUpperCase(), active: true }).lean();
    const now = new Date();
    if (!coupon || (coupon.validFrom && coupon.validFrom > now) || (coupon.validTo && coupon.validTo < now) || (coupon.maxUses && coupon.uses >= coupon.maxUses)) throw badRequest('Coupon is invalid or expired');
    d = { type: coupon.type as 'percent' | 'amount', value: coupon.value, reason: `Coupon ${coupon.code}`, couponCode: coupon.code };
  }
  const order = await mutateOrder(ctx, orderId, async (o) => {
    if (d.type !== 'none' && !d.reason) throw badRequest('A reason is required for discounts');
    if (coupon && coupon.minSpend && (o.totals?.subtotal ?? 0) < coupon.minSpend) throw badRequest('Order does not meet the coupon minimum spend');
    const subtotal = o.totals?.subtotal ?? 0;
    const pctBps = d.type === 'percent' ? Math.round(d.value * 100) : subtotal > 0 ? Math.round((d.value / subtotal) * 10000) : 0;
    if (d.type === 'percent' && (d.value < 0 || d.value > 100)) throw badRequest('Percentage must be between 0 and 100');
    if (!coupon && d.type !== 'none') {
      approvedBy = await resolveApproval(ctx, P.ORDERS_DISCOUNT, approval, 'Discounts');
      if (pctBps > (tenant?.settings?.discountApprovalThresholdBps ?? 1000)) approvedBy = await resolveApproval(ctx, P.ORDERS_DISCOUNT_APPROVE, approval, `Discounts above ${(tenant?.settings?.discountApprovalThresholdBps ?? 1000) / 100}%`);
    }
    o.set('discount', { type: d.type, value: d.value, reason: d.reason, approvedBy, couponCode: d.couponCode, amount: 0 });
    await recalc(o);
  });
  if (coupon) await Coupon.updateOne({ tenantId: ctx.tenantId, _id: coupon._id }, { $inc: { uses: 1 } });
  await audit(ctx, { action: 'order.discount', entity: 'Order', entityId: order._id, reason: d.reason, approvedBy, after: order.discount });
  return order;
}

/**
 * Send new lines to their stations. Food → kitchen, drinks → bar (from product/category routing).
 * The submissionKey makes double-taps and retries idempotent.
 */
export async function sendToStations(ctx: BranchContext, orderId: string, submissionKey?: string) {
  const created: Array<{ id: string; station: string }> = [];
  const order = await mutateOrder(ctx, orderId, async (o) => {
    const fresh = o.items.filter((i) => i.status === 'new' && !i.voided);
    if (!fresh.length) return;
    const key = submissionKey ?? createHash('sha256').update(fresh.map((i) => i.lineId).join(',')).digest('hex').slice(0, 32);
    const now = new Date();
    for (const station of ['kitchen', 'bar'] as const) {
      const lines = fresh.filter((i) => i.station === station);
      if (!lines.length) continue;
      let ticket = await KitchenTicket.findOne({ tenantId: ctx.tenantId, submissionKey: key, station });
      if (!ticket) {
        ticket = await KitchenTicket.create({
          tenantId: ctx.tenantId, branchId: ctx.branchId, orderId: o._id, orderNumber: o.number, station, tableNumber: o.tableNumber,
          orderType: o.type, waiterName: o.waiterName, priority: o.priority || lines.some((l) => l.priority), submissionKey: key,
          items: lines.map((l) => ({ lineId: l.lineId, name: l.name, qty: l.qty, modifiers: l.modifiers.map((m) => m.name), notes: l.notes, status: 'pending', ageRestricted: l.ageRestricted })),
        });
        created.push({ id: String(ticket._id), station });
      }
      for (const l of lines) {
        l.status = 'pending';
        l.ticketId = ticket._id;
        l.sentAt = now;
      }
    }
    // Items with no station (e.g. bottled water from the counter) are served directly.
    for (const l of fresh.filter((i) => i.station === 'none')) {
      l.status = 'served';
      l.sentAt = now;
      l.servedAt = now;
    }
  });
  for (const t of created) emitStation(ctx.tenantId, ctx.branchId, t.station, 'ticket.created', { id: t.id, orderNumber: order.number });
  if (created.length) await queueTicketPrints(ctx, created.map((c) => c.id));
  return { order, tickets: created };
}

/** Route new kitchen/bar tickets to the station printers of the branch (printed by the local bridge). */
async function queueTicketPrints(ctx: BranchContext, ticketIds: string[]) {
  const printers = await Printer.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, active: true, role: { $in: ['kitchen', 'bar'] }, connection: { $ne: 'browser' } }).lean();
  if (!printers.length) return;
  const tickets = await KitchenTicket.find({ tenantId: ctx.tenantId, _id: { $in: ticketIds } }).lean();
  for (const t of tickets) {
    for (const p of printers.filter((x) => x.role === t.station)) {
      await PrintJob.updateOne(
        { tenantId: ctx.tenantId, dedupeKey: `ticket:${t._id}:${p._id}` },
        { $setOnInsert: { branchId: ctx.branchId, printerId: p._id, kind: t.station === 'bar' ? 'bar_ticket' : 'kitchen_ticket', refId: t._id, requestedBy: ctx.userId, payload: {
          title: t.station === 'bar' ? 'BAR' : 'KITCHEN',
          meta: [`${t.tableNumber ? `Table ${t.tableNumber}` : String(t.orderType).replace('_', ' ')}  ${t.orderNumber}`, `${t.waiterName ?? ''}  ${new Date().toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}${t.priority ? '  PRIORITY' : ''}`],
          lines: t.items.map((i) => ({ qty: i.qty, name: i.name, modifiers: i.modifiers, notes: i.notes })),
        } } },
        { upsert: true },
      );
    }
  }
}

export async function setHold(ctx: BranchContext, orderId: string, hold: boolean) {
  return mutateOrder(ctx, orderId, async (o) => {
    o.status = hold ? 'held' : 'open';
  });
}

async function releaseTableIfFree(ctx: BranchContext, tableId?: Types.ObjectId | null, status: 'available' | 'cleaning' = 'available') {
  if (!tableId) return;
  const others = await Order.countDocuments({ tenantId: ctx.tenantId, branchId: ctx.branchId, tableId, status: { $in: OPEN } });
  if (!others) {
    await Table.updateOne({ tenantId: ctx.tenantId, _id: tableId }, { $set: { status }, $unset: { occupiedSince: 1, waiterId: 1 } });
    emitBranch(ctx.tenantId, ctx.branchId, 'table.updated', { id: String(tableId) });
  }
}

export async function transferTable(ctx: BranchContext, orderId: string, tableId: string) {
  const table = await Table.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: tableId, active: true });
  if (!table) throw notFound('Table');
  let previous: Types.ObjectId | undefined;
  const order = await mutateOrder(ctx, orderId, async (o) => {
    previous = o.tableId as Types.ObjectId | undefined;
    o.tableId = table._id;
    o.tableNumber = table.number;
    if (o.type !== 'dine_in') o.type = 'dine_in';
  });
  await Table.updateOne({ tenantId: ctx.tenantId, _id: table._id }, { $set: { status: 'occupied', occupiedSince: table.occupiedSince ?? new Date() } });
  await releaseTableIfFree(ctx, previous);
  await KitchenTicket.updateMany({ tenantId: ctx.tenantId, orderId: order._id }, { $set: { tableNumber: table.number } });
  await audit(ctx, { action: 'order.transfer_table', entity: 'Order', entityId: order._id, meta: { from: String(previous), to: tableId } });
  emitBranch(ctx.tenantId, ctx.branchId, 'table.updated', { id: tableId });
  return order;
}

/** Move all lines of `sourceId` into `targetId`. The source is closed as "merged". */
export async function mergeOrders(ctx: BranchContext, targetId: string, sourceId: string) {
  if (targetId === sourceId) throw badRequest('Cannot merge an order into itself');
  const source = await loadOrder(ctx, sourceId);
  if (!OPEN.includes(source.status)) throw conflict('Source order is closed', 'ORDER_LOCKED');
  if ((source.totals?.paid ?? 0) > 0) throw conflict('Cannot merge an order that has payments', 'ORDER_HAS_PAYMENTS');
  const target = await mutateOrder(ctx, targetId, async (o) => {
    const ids = new Set(o.items.map((i) => i.lineId));
    for (const it of source.items) if (!ids.has(it.lineId)) o.items.push(it.toObject() as never);
    await recalc(o);
  });
  await mutateOrder(ctx, sourceId, async (o) => {
    o.status = 'merged';
    o.mergedInto = target._id;
    for (const it of o.items) it.voided = true;
    await recalc(o);
  });
  await KitchenTicket.updateMany({ tenantId: ctx.tenantId, orderId: source._id }, { $set: { orderId: target._id, orderNumber: target.number, tableNumber: target.tableNumber } });
  if (String(source.tableId) !== String(target.tableId)) await releaseTableIfFree(ctx, source.tableId as Types.ObjectId);
  await audit(ctx, { action: 'order.merge', entity: 'Order', entityId: target._id, meta: { source: source.number, target: target.number } });
  return target;
}

/** Split selected lines (optionally partial quantities) into a new order on the same table — split bill by item. */
export async function splitOrder(ctx: BranchContext, orderId: string, lines: Array<{ lineId: string; qty?: number }>, toTableId?: string) {
  const source = await loadOrder(ctx, orderId);
  if (!OPEN.includes(source.status)) throw conflict('Order is closed', 'ORDER_LOCKED');
  if ((source.totals?.paid ?? 0) > 0) throw conflict('Split the bill before taking payments, or take partial payments by amount', 'ORDER_HAS_PAYMENTS');
  const moving: unknown[] = [];
  const updated = await mutateOrder(ctx, orderId, async (o) => {
    moving.length = 0;
    for (const sel of lines) {
      const line = o.items.find((i) => i.lineId === sel.lineId && !i.voided);
      if (!line) throw notFound('Order line');
      const q = sel.qty ?? line.qty;
      if (q <= 0 || q > line.qty) throw badRequest(`Invalid split quantity for ${line.name}`);
      const copy = { ...line.toObject(), lineId: randomUUID(), qty: q };
      moving.push(copy);
      if (q === line.qty) o.items.pull({ lineId: line.lineId } as never);
      else line.qty = Math.round((line.qty - q) * 1000) / 1000;
    }
    if (!o.items.some((i) => !i.voided)) throw badRequest('At least one item must remain on the original bill');
    await recalc(o);
  });
  const { order: child } = await createOrder(ctx, { type: updated.type as CreateOrderInput['type'], tableId: toTableId ?? (updated.tableId ? String(updated.tableId) : undefined), guests: 1, customerName: updated.customerName ?? undefined });
  const res = await mutateOrder(ctx, String(child._id), async (o) => {
    for (const m of moving) o.items.push(m as never);
    o.splitFrom = updated._id;
    await recalc(o);
  });
  await audit(ctx, { action: 'order.split', entity: 'Order', entityId: updated._id, meta: { newOrder: res.number, lines: lines.length } });
  return { source: updated, created: res };
}

export async function voidOrder(ctx: BranchContext, orderId: string, reason: string, approval?: ApprovalInput) {
  const approvedBy = await resolveApproval(ctx, P.ORDERS_VOID, approval, 'Voiding an order');
  const order = await mutateOrder(ctx, orderId, async (o) => {
    if ((o.totals?.paid ?? 0) > 0) throw conflict('Order has payments — refund them before voiding', 'ORDER_HAS_PAYMENTS');
    o.status = 'voided';
    o.voidedAt = new Date();
    o.voidReason = reason;
    for (const it of o.items) {
      if (!it.voided) {
        it.voided = true;
        it.voidReason = reason;
        if (it.status !== 'new' && it.status !== 'served') it.status = 'cancelled';
      }
    }
    await recalc(o);
  });
  await KitchenTicket.updateMany({ tenantId: ctx.tenantId, orderId: order._id, status: { $nin: ['completed'] } }, { $set: { status: 'cancelled' } });
  emitStation(ctx.tenantId, ctx.branchId, 'kitchen', 'ticket.updated', {});
  emitStation(ctx.tenantId, ctx.branchId, 'bar', 'ticket.updated', {});
  await releaseTableIfFree(ctx, order.tableId as Types.ObjectId);
  await audit(ctx, { action: 'order.void', entity: 'Order', entityId: order._id, reason, approvedBy, meta: { number: order.number, total: order.totals?.subtotal } });
  return order;
}

export { releaseTableIfFree, OPEN as OPEN_STATUSES, bpsOf, buildLines };
