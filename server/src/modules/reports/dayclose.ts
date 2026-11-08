import { z } from 'zod';
import { Types } from 'mongoose';
import { createModule } from '../../http/route';
import { PERMISSIONS as P } from '../../auth/permissions';
import type { TenantContext } from '../../http/context';
import { DayClose, Tenant } from '../../models';
import { badRequest, forbidden } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { audit } from '../../services/audit';
import { notify } from '../../services/notify';
import { docToText } from '../../services/receipt';
import { buildZReport, zReportDoc, type ZReport } from '../../services/zReport';

/**
 * End of day. Before closing it is an "X report" (figures so far); closing stores the figures as the Z report for that
 * business day, which is what is shown and printed afterwards (late changes don't alter a closed day silently —
 * closing again records a new version and is audited).
 */
const m = createModule('/day-close', 'End of day');
const zDay = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), branchId: z.string().optional() });

async function resolve(ctx: TenantContext, q: z.infer<typeof zDay>) {
  let branchIds: Types.ObjectId[];
  let key: Types.ObjectId | null;
  if (q.branchId === 'all') {
    if (!ctx.allBranches) throw forbidden('A business-wide end of day needs access to all branches');
    branchIds = ctx.allowedBranchIds;
    key = null;
  } else {
    const id = q.branchId ?? (ctx.branchId ? String(ctx.branchId) : undefined);
    if (!id || !ctx.allowedBranchIds.some((b) => String(b) === id)) throw forbidden('You are not assigned to this branch');
    branchIds = [new Types.ObjectId(id)];
    key = branchIds[0];
  }
  const tenant = await Tenant.findById(ctx.tenantId).select('settings.timezone').lean();
  const date = q.date ?? localDate(tenant?.settings?.timezone ?? 'Africa/Nairobi');
  return { branchIds, key, date };
}

m.route({ method: 'get', path: '', summary: 'End-of-day report for a business day (Z if closed, else X)', auth: 'tenant', permission: [P.REPORTS_SALES, P.CASH_SESSION_VIEW_ALL], query: zDay.extend({ live: z.enum(['0', '1']).optional() }) }, async ({ ctx, query }) => {
  const { branchIds, key, date } = await resolve(ctx, query);
  const closed = await DayClose.findOne({ tenantId: ctx.tenantId, branchId: key, date }).lean();
  const report = closed && query.live !== '1' ? (closed.snapshot as ZReport) : await buildZReport(ctx.tenantId as Types.ObjectId, branchIds, date);
  const meta = closed ? { closedAt: closed.closedAt, closedByName: closed.closedByName, timesClosed: closed.timesClosed } : null;
  return { report, closed: meta, doc: zReportDoc(report, closed && query.live !== '1' ? meta : null) };
});

m.route({ method: 'post', path: '/close', summary: 'Close the business day (stores the Z report)', auth: 'tenant', permission: P.CASH_SESSION_VIEW_ALL, body: zDay }, async ({ ctx, body, req }) => {
  const { branchIds, key, date } = await resolve(ctx, body);
  const tenant = await Tenant.findById(ctx.tenantId).select('settings.timezone').lean();
  if (date > localDate(tenant?.settings?.timezone ?? 'Africa/Nairobi')) throw badRequest('That day has not started yet');
  const report = await buildZReport(ctx.tenantId as Types.ObjectId, branchIds, date);
  const prev = await DayClose.findOne({ tenantId: ctx.tenantId, branchId: key, date }).lean();
  const doc = await DayClose.findOneAndUpdate(
    { tenantId: ctx.tenantId, branchId: key, date },
    { $set: { snapshot: report, closedBy: ctx.userId, closedByName: ctx.userName, closedAt: new Date() }, $inc: { timesClosed: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: false },
  ).lean();
  await audit(ctx, { action: prev ? 'day.reclosed' : 'day.closed', entity: 'DayClose', entityId: doc!._id, before: prev ? { gross: (prev.snapshot as ZReport).sales.gross } : undefined, after: { date, gross: report.sales.gross, orders: report.sales.orders } }, req);
  const meta = { closedAt: doc!.closedAt, closedByName: doc!.closedByName, timesClosed: doc!.timesClosed };
  return { report, closed: meta, doc: zReportDoc(report, meta) };
});

m.route({
  method: 'post', path: '/send', summary: 'Send the end-of-day report to the owner (SMS and/or email)', auth: 'tenant', permission: [P.REPORTS_SALES, P.CASH_SESSION_VIEW_ALL],
  body: zDay.extend({ channel: z.enum(['sms', 'email', 'both']).default('both'), to: z.string().max(120).optional() }),
}, async ({ ctx, body }) => {
  const { branchIds, key, date } = await resolve(ctx, body);
  const closed = await DayClose.findOne({ tenantId: ctx.tenantId, branchId: key, date }).lean();
  const report = closed ? (closed.snapshot as ZReport) : await buildZReport(ctx.tenantId as Types.ObjectId, branchIds, date);
  const tenant = await Tenant.findById(ctx.tenantId).lean();
  const text = docToText(zReportDoc(report, closed ? { closedAt: closed.closedAt, closedByName: closed.closedByName } : null));
  const emails = body.to?.includes('@') ? [body.to] : body.to ? [] : tenant?.settings?.alertEmails ?? [];
  const phones = body.to && !body.to.includes('@') ? [body.to] : body.to ? [] : tenant?.settings?.alertPhones ?? [];
  const vars = { branch_name: report.branches.join(', ') || 'All branches', date, total_sales: (report.sales.gross / 100).toFixed(2), order_count: report.sales.orders, avg_order: (report.sales.average / 100).toFixed(2), details: text };
  const stamp = Date.now();
  const sent: string[] = [];
  if (body.channel !== 'sms') for (const to of emails) { await notify(ctx.tenantId as Types.ObjectId, { event: 'manager_sales_summary', channel: 'email', to, vars, dedupeKey: `z:${key ?? 'all'}:${date}:email:${to}:${stamp}` }); sent.push(to); }
  if (body.channel !== 'email') for (const to of phones) { await notify(ctx.tenantId as Types.ObjectId, { event: 'manager_sales_summary', channel: 'sms', to, vars, dedupeKey: `z:${key ?? 'all'}:${date}:sms:${to}:${stamp}` }); sent.push(to); }
  if (!sent.length) throw badRequest('No recipients: add alert emails / phones in Settings → Business, or enter one');
  return { sent };
});

export default m;
