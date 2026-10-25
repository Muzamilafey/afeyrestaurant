import { z } from 'zod';
import { createModule, zId, zMoney } from '../../http/route';
import { CashSession, CashMovement, Payment, Refund, Expense } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { withTransaction } from '../../db/connect';
import { audit } from '../../services/audit';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { drawerMode, findOpenDrawer, noDrawerMessage } from '../../services/cash';

const m = createModule('/cash', 'Cash & Expenses');

/** Compute expected drawer cash from the immutable payment/refund/movement records. */
export async function sessionTotals(tenantId: unknown, s: { _id: unknown; openingFloat: number; userId: unknown; branchId: unknown; openedAt: Date; closedAt?: Date | null; shared?: boolean | null }) {
  // A personal drawer holds what that cashier took; the shared drawer holds what everyone in the branch took while it
  // was open (personal and shared drawers never overlap — the mode can only change when every drawer is closed).
  const who = s.shared ? {} : { receivedBy: s.userId };
  const whoRefund = s.shared ? {} : { requestedBy: s.userId };
  const [pays, refunds, moves] = await Promise.all([
    Payment.aggregate([{ $match: { tenantId, branchId: s.branchId, ...who, receivedAt: { $gte: s.openedAt, ...(s.closedAt ? { $lte: s.closedAt } : {}) } } }, { $group: { _id: '$method', amount: { $sum: '$amount' }, tips: { $sum: { $ifNull: ['$tip', 0] } }, count: { $sum: 1 } } }]),
    Refund.aggregate([{ $match: { tenantId, branchId: s.branchId, ...whoRefund, method: 'cash', createdAt: { $gte: s.openedAt, ...(s.closedAt ? { $lte: s.closedAt } : {}) } } }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
    CashMovement.aggregate([{ $match: { tenantId, sessionId: s._id } }, { $group: { _id: '$type', amount: { $sum: '$amount' } } }]),
  ]);
  const by = (k: string) => pays.find((p) => p._id === k)?.amount ?? 0;
  const mv = (k: string) => moves.find((p) => p._id === k)?.amount ?? 0;
  const cashSales = by('cash');
  // Cash tips are in the drawer too (kept out of sales; paid out to staff from the drawer or at cash-up).
  const cashTips = pays.find((p) => p._id === 'cash')?.tips ?? 0;
  const tips = pays.reduce((a, p) => a + (p.tips ?? 0), 0);
  const cashRefunds = refunds[0]?.amount ?? 0;
  const expected = s.openingFloat + cashSales + cashTips - cashRefunds - mv('drop') - mv('expense') - mv('payout') + mv('pay_in');
  return {
    totals: { cashSales, cashRefunds, drops: mv('drop'), expenses: mv('expense') + mv('payout'), payIns: mv('pay_in'), mpesa: by('mpesa'), card: by('card') + by('qr'), other: by('account') + by('voucher'), cashTips, tips },
    byMethod: pays,
    expected,
  };
}

m.route({ method: 'get', path: '/mode', summary: "This branch's cash drawer mode (per user or one shared drawer)", permission: [P.CASH_SESSION, P.PAYMENTS_RECEIVE] }, async ({ ctx }) => ({ mode: await drawerMode(ctx) }));

m.route({ method: 'get', path: '/session', summary: 'The open cash drawer I use: my own, or the shared branch drawer', permission: P.CASH_SESSION }, async ({ ctx }) => {
  const { drawer } = await findOpenDrawer(ctx);
  const s = drawer?.toObject();
  if (!s) return null;
  const t = await sessionTotals(ctx.tenantId, s);
  const movements = await CashMovement.find({ tenantId: ctx.tenantId, sessionId: s._id }).sort({ createdAt: -1 }).lean();
  return { ...s, ...t, movements };
});

m.route({ method: 'post', path: '/session/open', summary: 'Open cash drawer with an opening float', permission: P.CASH_SESSION, body: z.object({ openingFloat: zMoney, terminal: z.string().max(40).optional() }), status: 201 }, async ({ ctx, body, req }) => {
  const mode = await drawerMode(ctx);
  const shared = mode === 'shared';
  try {
    const s = await CashSession.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, userId: ctx.userId, userName: ctx.userName, openingFloat: body.openingFloat, terminal: body.terminal, shared });
    await audit(ctx, { action: 'cash.session_opened', entity: 'CashSession', entityId: s._id, meta: { openingFloat: body.openingFloat, shared } }, req);
    return s;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw conflict(shared ? 'The shared cash drawer is already open' : 'You already have an open cash drawer', 'SESSION_OPEN');
    throw e;
  }
});

m.route({ method: 'post', path: '/session/movement', summary: 'Cash drop, pay-in, payout or petty-cash expense', permission: P.CASH_SESSION, body: z.object({ type: z.enum(['drop', 'pay_in', 'payout', 'expense']), amount: zMoney, reason: z.string().min(3).max(200), expenseCategory: z.string().max(40).optional() }), status: 201 }, async ({ ctx, body, req }) => {
  const { drawer: s, mode } = await findOpenDrawer(ctx);
  if (!s) throw new AppError(409, 'NO_CASH_SESSION', noDrawerMessage(mode, 'first'));
  if (body.amount <= 0) throw badRequest('Amount must be positive');
  const mv = await withTransaction(async (session) => {
    let expenseId;
    if (body.type === 'expense') {
      if (!ctx.permissions.has(P.EXPENSES_MANAGE) && !ctx.permissions.has(P.CASH_SESSION)) throw forbidden();
      const [e] = await Expense.create([{ tenantId: ctx.tenantId, branchId: ctx.branchId, category: body.expenseCategory ?? 'Petty cash', description: body.reason, amount: body.amount, paidFrom: 'cash_drawer', recordedBy: ctx.userId, cashSessionId: s._id }], { session });
      expenseId = e._id;
    }
    const [m] = await CashMovement.create([{ tenantId: ctx.tenantId, branchId: ctx.branchId, sessionId: s._id, type: body.type, amount: body.amount, reason: body.reason, by: ctx.userId, expenseId }], { session });
    return m;
  });
  await audit(ctx, { action: `cash.${body.type}`, entity: 'CashSession', entityId: s._id, reason: body.reason, meta: { amount: body.amount } }, req);
  return mv;
});

m.route({ method: 'post', path: '/session/close', summary: 'Close drawer: counted vs expected cash', permission: P.CASH_SESSION, body: z.object({ countedCash: zMoney, denominations: z.array(z.object({ value: z.number().int().positive(), count: z.number().int().min(0) })).optional(), notes: z.string().max(500).optional() }) }, async ({ ctx, body, req }) => {
  const { drawer: s } = await findOpenDrawer(ctx);
  if (!s) throw notFound('Open cash session');
  const closedAt = new Date();
  const t = await sessionTotals(ctx.tenantId, { ...s.toObject(), closedAt });
  if (body.denominations) {
    const sum = body.denominations.reduce((a, d) => a + d.value * d.count, 0);
    if (sum !== body.countedCash) throw badRequest('Denomination breakdown does not add up to the counted cash');
  }
  s.set({ status: 'closed', closedAt, countedCash: body.countedCash, expectedCash: t.expected, variance: body.countedCash - t.expected, denominations: body.denominations, totals: t.totals, closingNotes: body.notes, closedBy: ctx.userId });
  await s.save();
  await audit(ctx, { action: 'cash.session_closed', entity: 'CashSession', entityId: s._id, meta: { expected: t.expected, counted: body.countedCash, variance: s.variance } }, req);
  return s;
});

m.route({ method: 'get', path: '/sessions', summary: 'Cash sessions (own, or all with cash.session_view_all)', permission: [P.CASH_SESSION, P.CASH_SESSION_VIEW_ALL], query: z.object({ from: z.coerce.date().optional(), status: z.string().optional() }) }, async ({ ctx, query }) => {
  const f: Record<string, unknown> = { tenantId: ctx.tenantId, branchId: ctx.branchId };
  if (!ctx.permissions.has(P.CASH_SESSION_VIEW_ALL)) f.$or = [{ userId: ctx.userId }, { shared: true }];
  if (query.from) f.openedAt = { $gte: query.from };
  if (query.status) f.status = query.status;
  return CashSession.find(f).sort({ openedAt: -1 }).limit(200).lean();
});

// ── Expenses ──
m.route({ method: 'get', path: '/expenses', summary: 'Expenses', permission: [P.EXPENSES_MANAGE, P.ACCOUNTING_VIEW], query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }, async ({ ctx, query }) =>
  Expense.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, ...(query.from || query.to ? { date: { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } } : {}) }).sort({ date: -1 }).limit(500).lean(),
);
m.route({ method: 'post', path: '/expenses', summary: 'Record an expense (non-drawer)', permission: P.EXPENSES_MANAGE, status: 201, body: z.object({ category: z.string().min(2).max(40), description: z.string().max(300).optional(), amount: zMoney, paidFrom: z.enum(['mpesa', 'bank', 'petty_cash', 'other']), supplierId: zId.optional(), reference: z.string().max(60).optional(), date: z.coerce.date().optional() }) }, async ({ ctx, body, req }) => {
  const e = await Expense.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId, recordedBy: ctx.userId });
  await audit(ctx, { action: 'expense.recorded', entity: 'Expense', entityId: e._id, meta: { amount: e.amount, category: e.category } }, req);
  return e;
});
/** Expenses are never edited or deleted — corrections are reversal entries. */
m.route({ method: 'post', path: '/expenses/:id/reverse', summary: 'Reverse an expense (adjustment entry)', permission: P.EXPENSES_MANAGE, body: z.object({ reason: z.string().min(3).max(200) }) }, async ({ ctx, params, body, req }) => {
  const e = await Expense.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!e) throw notFound('Expense');
  if (e.reversedBy || e.reversalOf) throw conflict('Expense already reversed');
  const rev = await Expense.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, category: e.category, description: `Reversal: ${body.reason}`, amount: -e.amount, paidFrom: e.paidFrom, reversalOf: e._id, recordedBy: ctx.userId });
  e.reversedBy = rev._id;
  await e.save();
  await audit(ctx, { action: 'expense.reversed', entity: 'Expense', entityId: e._id, reason: body.reason }, req);
  return rev;
});

export default m;
