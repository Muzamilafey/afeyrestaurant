import type { Types } from 'mongoose';
import { Order, Payment, Branch, Table } from '../models';
import type { BranchContext } from '../http/context';
import { buildLines, recalc, type ItemInput } from './orders';
import { finalizePaidOrder, emitTicketsClosed } from './payments';
import { findOpenDrawer } from './cash';
import { confirmOfflineMpesa } from './offlineMpesa';
import { withTransaction } from '../db/connect';
import { nextNumber } from './counters';
import { audit } from './audit';
import { emitBranch } from '../realtime/bus';

export interface OfflineOrder {
  clientId: string;
  terminalId: string;
  createdAt: Date;
  type: 'dine_in' | 'takeaway' | 'bar_counter';
  outlet?: 'restaurant' | 'bar';
  tableId?: string;
  customerName?: string;
  notes?: string;
  items: Array<ItemInput & { lineId: string; unitPrice: number }>;
  payments: Array<{ clientPaymentId: string; method: 'cash' | 'card' | 'mpesa'; amount: number; tendered?: number; reference?: string; phone?: string }>;
}

export type SyncResult = { clientId: string; status: 'created' | 'duplicate' | 'rejected'; orderId?: string; number?: string; error?: string; priceConflicts?: number };

/**
 * Apply one offline order. Idempotent by clientId (order) and clientPaymentId (payments):
 * re-sending after a dropped connection returns "duplicate" and never creates a second sale or stock deduction.
 * Offline prices are honoured (the customer paid them) and differences from current prices are flagged.
 * Offline cash is recorded with verification "offline_cash" so reports distinguish it from cloud-verified payments.
 */
export async function syncOfflineOrder(ctx: BranchContext, o: OfflineOrder): Promise<SyncResult> {
  const existing = await Order.findOne({ tenantId: ctx.tenantId, clientId: o.clientId }).lean();
  if (existing) return { clientId: o.clientId, status: 'duplicate', orderId: String(existing._id), number: existing.number };
  try {
    const lines = await buildLines(ctx, o.items, { offline: true });
    const conflicts: Array<{ lineId: string; offlinePrice: number; currentPrice: number }> = [];
    lines.forEach((l, i) => {
      const offlinePrice = o.items[i].unitPrice;
      if (offlinePrice !== l.unitPrice) conflicts.push({ lineId: l.lineId, offlinePrice, currentPrice: l.unitPrice });
      l.unitPrice = offlinePrice;
      l.status = 'served'; // served at the counter while offline; not re-sent to the kitchen
    });
    const branch = await Branch.findOne({ tenantId: ctx.tenantId, _id: ctx.branchId }).lean();
    const table = o.tableId ? await Table.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: o.tableId }).lean() : null;
    const result = await withTransaction(async (session) => {
      const number = await nextNumber(ctx.tenantId, branch?.settings?.orderPrefix ?? 'ORD', branch?.code ?? 'BR', session);
      const order = new Order({
        tenantId: ctx.tenantId, branchId: ctx.branchId, number, clientId: o.clientId, source: 'offline', type: o.type, outlet: o.outlet ?? (o.type === 'bar_counter' ? 'bar' : 'restaurant'), tableId: table?._id, tableNumber: table?.number,
        waiterId: ctx.userId, waiterName: ctx.userName, cashierId: ctx.userId, customerName: o.customerName, notes: o.notes, items: lines,
        offline: { createdAt: o.createdAt, terminalId: o.terminalId, syncedAt: new Date(), priceConflicts: conflicts },
      });
      await recalc(order, session);
      const { drawer: cs } = await findOpenDrawer(ctx, session);
      let paid = 0;
      const mpesaCodes: string[] = [];
      const reusedCodes: string[] = [];
      for (const p of o.payments) {
        const amount = Math.min(p.amount, order.totals!.total - paid);
        if (amount <= 0) break;
        const key = `offline:${p.clientPaymentId}`;
        if (await Payment.exists({ tenantId: ctx.tenantId, idempotencyKey: key }).session(session)) continue;
        const base = { tenantId: ctx.tenantId, branchId: ctx.branchId, orderId: order._id, orderNumber: number, amount, receivedBy: ctx.userId, idempotencyKey: key, receivedAt: o.createdAt };
        if (p.method === 'card') {
          // Approved on the card terminal at the till; recorded like a manually confirmed card payment.
          await Payment.create([{ ...base, method: 'card', reference: p.reference, verification: 'manual', manualConfirmation: { by: ctx.userId, reason: 'Card payment taken while offline' } }], { session });
        } else if (p.method === 'mpesa') {
          const code = (p.reference ?? '').toUpperCase();
          const used = await Payment.exists({ tenantId: ctx.tenantId, method: 'mpesa', reference: code }).session(session);
          await Payment.create([{ ...base, method: 'mpesa', phone: p.phone, status: 'provisional', verification: 'offline_mpesa', ...(used ? { claimedReference: code } : { reference: code }) }], { session });
          if (used) reusedCodes.push(code);
          else mpesaCodes.push(code);
        } else {
          const tendered = p.tendered ?? amount;
          await Payment.create([{ ...base, method: 'cash', tendered, change: Math.max(0, tendered - amount), verification: 'offline_cash', cashSessionId: cs?._id as Types.ObjectId | undefined }], { session });
        }
        paid += amount;
      }
      order.totals!.paid = paid;
      order.totals!.balance = order.totals!.total - paid;
      order.paymentStatus = paid <= 0 ? 'unpaid' : order.totals!.balance <= 0 ? 'paid' : 'partial';
      if (order.totals!.balance <= 0 && paid > 0) await finalizePaidOrder(order, session);
      await order.save({ session });
      // Confirm offline M-Pesa codes whose Till/Paybill confirmation is already here.
      for (const code of mpesaCodes) await confirmOfflineMpesa(ctx.tenantId, code, session);
      if (reusedCodes.length) await audit(ctx, { action: 'sync.mpesa_code_reused', entity: 'Order', entityId: order._id, meta: { codes: reusedCodes } });
      return order;
    });
    if (conflicts.length) await audit(ctx, { action: 'sync.price_conflict', entity: 'Order', entityId: result._id, meta: { conflicts } });
    emitBranch(ctx.tenantId, ctx.branchId, 'order.updated', { id: String(result._id) });
    emitTicketsClosed(result);
    return { clientId: o.clientId, status: 'created', orderId: String(result._id), number: result.number, priceConflicts: conflicts.length };
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const dup = await Order.findOne({ tenantId: ctx.tenantId, clientId: o.clientId }).lean();
      if (dup) return { clientId: o.clientId, status: 'duplicate', orderId: String(dup._id), number: dup.number };
    }
    return { clientId: o.clientId, status: 'rejected', error: (e as Error).message };
  }
}
