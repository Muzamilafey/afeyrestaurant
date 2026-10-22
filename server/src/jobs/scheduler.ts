import type { Types } from 'mongoose';
import { PaymentAttempt, Reservation, Tenant, Branch, Order } from '../models';
import { processNotificationQueue, notify } from '../services/notify';
import { queryAttempt } from '../services/payments';
import { lowStockItems } from '../modules/inventory/routes';
import { localParts } from '../services/pricing';
import { logger } from '../lib/logger';

const G = { skipTenantGuard: true };

/** Re-query M-Pesa attempts whose callback is overdue; expire stale simulated attempts. */
export async function reconcileMpesa() {
  const due = await PaymentAttempt.find({ method: 'mpesa', status: { $in: ['pending', 'initiated'] }, expiresAt: { $lt: new Date(Date.now() - 15_000) }, $or: [{ lastQueryAt: null }, { lastQueryAt: { $lt: new Date(Date.now() - 60_000) } }], createdAt: { $gt: new Date(Date.now() - 24 * 3600_000) } }).setOptions(G).limit(50).lean();
  for (const a of due) {
    try {
      const r = await queryAttempt(a.tenantId as Types.ObjectId, a._id);
      // After 10 minutes without a definitive answer, stop waiting; a later callback is still honoured.
      if (['pending', 'initiated'].includes(r.status as string) && a.expiresAt && a.expiresAt < new Date(Date.now() - 10 * 60_000)) {
        await PaymentAttempt.updateOne({ tenantId: a.tenantId, _id: a._id, status: { $in: ['pending', 'initiated'] } }, { $set: { status: 'timeout', resultDesc: 'No confirmation received from M-Pesa' } });
      }
    } catch (e) {
      logger.warn({ err: e, attemptId: a._id }, 'M-Pesa status query failed');
    }
  }
  return due.length;
}

export async function reservationReminders() {
  const soon = await Reservation.find({ status: 'confirmed', reminderSentAt: null, startsAt: { $gt: new Date(), $lt: new Date(Date.now() + 3 * 3600_000) } }).setOptions(G).limit(200);
  for (const r of soon) {
    if (!r.phone) continue;
    const t = await Tenant.findById(r.tenantId).lean();
    const lp = localParts(t?.settings?.timezone ?? 'Africa/Nairobi', r.startsAt);
    await notify(r.tenantId as Types.ObjectId, { event: 'reservation_reminder', channel: 'sms', to: r.phone, vars: { customer_name: r.customerName, reservation_time: lp.time, guest_count: r.partySize, reservation_code: r.code }, dedupeKey: `resrem:${r._id}` });
    r.reminderSentAt = new Date();
    await r.save();
  }
}

export async function dailyTasks() {
  const tenants = await Tenant.find().lean(); // the single business
  for (const t of tenants) {
    const tz = t.settings?.timezone ?? 'Africa/Nairobi';
    const today = localParts(tz).date;
    const branches = await Branch.find({ tenantId: t._id, active: true }).lean();
    for (const b of branches) {
      if (t.settings?.lowStockAlerts !== false) {
        const low = await lowStockItems(t._id, b._id);
        if (low.length) {
          const items = low.map((l) => `${l.name}: ${Math.round(l.qty)}${l.unit} (min ${l.min})`).join('\n');
          for (const to of t.settings?.alertEmails ?? []) await notify(t._id, { event: 'low_stock_alert', channel: 'email', to, vars: { branch_name: b.name, items }, dedupeKey: `lowstock:${b._id}:${today}:${to}` });
          for (const to of t.settings?.alertPhones ?? []) await notify(t._id, { event: 'low_stock_alert', channel: 'sms', to, vars: { branch_name: b.name, items: low.slice(0, 5).map((l) => l.name).join(', ') }, dedupeKey: `lowstock:${b._id}:${today}:${to}` });
        }
      }
      if (t.settings?.dailySummary) {
        const since = new Date(Date.now() - 24 * 3600_000);
        const [s] = await Order.aggregate([{ $match: { tenantId: t._id, branchId: b._id, status: 'paid', paidAt: { $gte: since } } }, { $group: { _id: null, total: { $sum: '$totals.total' }, n: { $sum: 1 } } }]);
        const vars = { branch_name: b.name, date: today, total_sales: ((s?.total ?? 0) / 100).toFixed(2), order_count: s?.n ?? 0, avg_order: s?.n ? (s.total / s.n / 100).toFixed(2) : '0.00', details: '' };
        for (const to of t.settings?.alertEmails ?? []) await notify(t._id, { event: 'manager_sales_summary', channel: 'email', to, vars, dedupeKey: `summary:${b._id}:${today}:${to}` });
        for (const to of t.settings?.alertPhones ?? []) await notify(t._id, { event: 'manager_sales_summary', channel: 'sms', to, vars, dedupeKey: `summary:${b._id}:${today}:${to}` });
      }
    }
  }
}

/** Start in-process schedules. Each task is guarded against overlapping runs. */
export function startScheduler() {
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let running = false;
    timers.push(
      setInterval(async () => {
        if (running) return;
        running = true;
        try {
          await fn();
        } catch (e) {
          logger.error({ err: e, task: name }, 'Scheduled task failed');
        } finally {
          running = false;
        }
      }, ms),
    );
  };
  every(3_000, 'notifications', () => processNotificationQueue(25));
  every(30_000, 'mpesa-reconcile', reconcileMpesa);
  every(5 * 60_000, 'reservation-reminders', reservationReminders);
  every(60 * 60_000, 'daily', dailyTasks);
  logger.info('Background scheduler started');
  return () => timers.forEach(clearInterval);
}
