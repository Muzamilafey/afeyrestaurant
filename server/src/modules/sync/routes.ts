import { z } from 'zod';
import { createModule, zId, zMoney } from '../../http/route';
import { PERMISSIONS as P } from '../../auth/permissions';
import { syncOfflineOrder } from '../../services/sync';
import { Tenant } from '../../models';
import { forbidden } from '../../lib/errors';
import { offlineMethodAllowed } from '../../services/offlineMpesa';

const m = createModule('/sync', 'Offline sync');

m.route(
  {
    method: 'post', path: '/orders', summary: 'Synchronise offline orders in creation order (idempotent)', permission: P.ORDERS_CREATE,
    body: z.object({
      orders: z.array(z.object({
        clientId: z.uuid(), terminalId: z.string().max(60), createdAt: z.coerce.date(), type: z.enum(['dine_in', 'takeaway', 'bar_counter']), outlet: z.enum(['restaurant', 'bar']).optional(), tableId: zId.optional(),
        customerName: z.string().max(80).optional(), notes: z.string().max(500).optional(),
        items: z.array(z.object({ lineId: z.uuid(), productId: zId, qty: z.number().positive().max(999), variant: z.string().max(40).optional(), modifiers: z.array(z.object({ groupId: zId, optionId: zId })).optional(), notes: z.string().max(300).optional(), unitPrice: zMoney })).min(1).max(100),
        payments: z.array(z.object({
          clientPaymentId: z.uuid(), method: z.enum(['cash', 'card', 'mpesa']).default('cash'), amount: zMoney, tendered: zMoney.optional(),
          // Card approval code (optional) or the M-Pesa transaction code the customer received (required for M-Pesa).
          reference: z.string().trim().max(40).optional(), phone: z.string().max(20).optional(),
        }).refine((p) => p.method !== 'mpesa' || /^[A-Za-z0-9]{8,12}$/.test(p.reference ?? ''), { message: 'M-Pesa payments need the transaction code' })).max(10),
      })).min(1).max(50),
    }),
  },
  async ({ ctx, body }) => {
    const tenant = await Tenant.findById(ctx.tenantId).lean();
    const allowed = tenant?.settings?.offlineAllowedActions ?? [];
    if (!allowed.includes('create_order')) throw forbidden('Offline ordering is disabled for this restaurant');
    const results = [];
    // Ordered processing: events are applied in the sequence they happened at the terminal.
    for (const o of [...body.orders].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      const blocked = o.payments.find((p) => !offlineMethodAllowed(allowed, p.method));
      if (blocked) {
        results.push({ clientId: o.clientId, status: 'rejected' as const, error: `Offline ${blocked.method === 'mpesa' ? 'M-Pesa' : blocked.method} payments are disabled` });
        continue;
      }
      if (o.payments.length && !ctx.permissions.has(P.PAYMENTS_RECEIVE)) {
        results.push({ clientId: o.clientId, status: 'rejected' as const, error: 'Missing permission: payments.receive' });
        continue;
      }
      results.push(await syncOfflineOrder(ctx, o));
    }
    return { results };
  },
);

export default m;
