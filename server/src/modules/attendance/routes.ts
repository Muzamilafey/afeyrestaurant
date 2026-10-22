import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { createModule, zId } from '../../http/route';
import { Employee, BiometricDevice, BiometricEnrollmentReference, AttendanceEvent, Shift, ShiftAssignment, BridgeAgent, BridgeCommand, PrintJob, Printer, User, Tenant } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { audit } from '../../services/audit';
import { attendanceReport, toCsv } from '../../services/attendance';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../../lib/errors';
import { sha256 } from '../../lib/crypto';
import { verifyPassword } from '../../auth/password';
import { notify } from '../../services/notify';

const m = createModule('/staff', 'Staff & Attendance');

// ── Employees ──
const zEmployee = z.object({ employeeNo: z.string().min(1).max(20), name: z.string().min(2).max(80), phone: z.string().max(20).optional(), email: z.email().optional(), jobTitle: z.string().max(60).optional(), hourlyRate: z.number().int().min(0).optional(), deviceUserCode: z.string().regex(/^\d{1,9}$/).optional(), userId: zId.optional(), active: z.boolean().optional() });
m.route({ method: 'get', path: '/employees', summary: 'Employees at the branch', permission: [P.STAFF_VIEW, P.ATTENDANCE_VIEW] }, async ({ ctx }) => Employee.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).sort({ name: 1 }).lean());
m.route({ method: 'post', path: '/employees', summary: 'Add employee', permission: P.STAFF_MANAGE, body: zEmployee, status: 201 }, async ({ ctx, body }) => Employee.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId }));
m.route({ method: 'patch', path: '/employees/:id', summary: 'Update employee', permission: P.STAFF_MANAGE, body: zEmployee.partial() }, async ({ ctx, params, body }) => {
  const e = await Employee.findOneAndUpdate({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id }, { $set: body }, { new: true });
  if (!e) throw notFound('Employee');
  return e;
});

/** Record informed consent before biometric enrolment (Data Protection Act 2019, s.26 & s.30 — sensitive personal data). */
m.route({ method: 'post', path: '/employees/:id/biometric-consent', summary: 'Record or withdraw biometric consent', permission: P.BIOMETRIC_ENROLL, body: z.object({ given: z.boolean(), noticeVersion: z.string().max(20).default('v1') }) }, async ({ ctx, params, body, req }) => {
  const e = await Employee.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!e) throw notFound('Employee');
  if (body.given) e.set('biometricConsent', { given: true, at: new Date(), recordedBy: ctx.userId, noticeVersion: body.noticeVersion, withdrawnAt: undefined });
  else {
    e.set('biometricConsent.given', false);
    e.set('biometricConsent.withdrawnAt', new Date());
    // Withdrawal triggers deletion of the templates held on devices.
    const refs = await BiometricEnrollmentReference.find({ tenantId: ctx.tenantId, employeeId: e._id, status: { $ne: 'deleted' } }).lean();
    for (const r of refs) {
      const dev = await BiometricDevice.findOne({ tenantId: ctx.tenantId, _id: r.deviceId }).lean();
      if (dev?.bridgeId) await BridgeCommand.create({ tenantId: ctx.tenantId, bridgeId: dev.bridgeId, deviceId: dev._id, type: 'delete_user', payload: { deviceUserCode: r.deviceUserCode, enrollmentId: String(r._id) }, requestedBy: ctx.userId });
    }
  }
  await e.save();
  await audit(ctx, { action: body.given ? 'biometric.consent_given' : 'biometric.consent_withdrawn', entity: 'Employee', entityId: e._id }, req);
  return e;
});

// ── Devices ──
const zDevice = z.object({
  name: z.string().min(2).max(60), vendor: z.enum(['zkteco', 'secugen', 'mock']), deviceType: z.enum(['zkteco_terminal', 'secugen_usb', 'mock']), model: z.string().max(40).optional(), serialNumber: z.string().max(40).optional(),
  connection: z.enum(['tcp', 'udp', 'usb_bridge', 'mock']), host: z.string().max(100).optional(), port: z.number().int().min(1).max(65535).optional(), bridgeId: zId.optional(), timezone: z.string().optional(), active: z.boolean().optional(),
});
m.route({ method: 'get', path: '/devices', summary: 'Biometric devices', permission: [P.DEVICES_MANAGE, P.ATTENDANCE_VIEW] }, async ({ ctx }) => BiometricDevice.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).lean());
m.route({ method: 'post', path: '/devices', summary: 'Register a biometric device (unverified until physically tested)', permission: P.DEVICES_MANAGE, feature: 'biometrics', body: zDevice, status: 201 }, async ({ ctx, body, req }) => {
  if (body.vendor === 'zkteco' && (body.deviceType !== 'zkteco_terminal' || !['tcp', 'udp'].includes(body.connection) || !body.host)) throw badRequest('ZKTeco terminals need a LAN IP and TCP/UDP connection');
  if (body.vendor === 'secugen' && (body.deviceType !== 'secugen_usb' || body.connection !== 'usb_bridge')) throw badRequest('SecuGen readers connect over USB through the local bridge');
  if (body.vendor !== 'mock' && !body.bridgeId) throw badRequest('Select the bridge that can reach this device');
  if (body.bridgeId && !(await BridgeAgent.exists({ tenantId: ctx.tenantId, _id: body.bridgeId, active: true }))) throw notFound('Bridge');
  const d = await BiometricDevice.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId, verified: false });
  await audit(ctx, { action: 'device.registered', entity: 'BiometricDevice', entityId: d._id, meta: { vendor: d.vendor, model: d.model } }, req);
  return d;
});
m.route({ method: 'patch', path: '/devices/:id', summary: 'Update a device / mark verified after a physical test', permission: P.DEVICES_MANAGE, body: zDevice.partial().extend({ verified: z.boolean().optional(), verificationNotes: z.string().max(500).optional() }) }, async ({ ctx, params, body, req }) => {
  const d = await BiometricDevice.findOneAndUpdate({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id }, { $set: body }, { new: true });
  if (!d) throw notFound('Device');
  if (body.verified !== undefined) await audit(ctx, { action: 'device.verification_changed', entity: 'BiometricDevice', entityId: d._id, meta: { verified: body.verified, notes: body.verificationNotes } }, req);
  return d;
});
m.route({ method: 'post', path: '/devices/:id/commands', summary: 'Queue a device command for the bridge (test, sync time, pull logs, list users)', permission: P.DEVICES_MANAGE, body: z.object({ type: z.enum(['device_test', 'sync_time', 'pull_attendance', 'list_users']) }), status: 201 }, async ({ ctx, params, body }) => {
  const d = await BiometricDevice.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id }).lean();
  if (!d) throw notFound('Device');
  if (d.vendor === 'mock') return { simulated: true, status: 'done', result: { ok: true, message: 'SIMULATED device — no hardware contacted' } };
  if (!d.bridgeId) throw badRequest('Device has no bridge');
  return BridgeCommand.create({ tenantId: ctx.tenantId, bridgeId: d.bridgeId, deviceId: d._id, type: body.type, payload: { since: d.lastSyncAt }, requestedBy: ctx.userId });
});
m.route({ method: 'get', path: '/devices/:id/commands', summary: 'Recent device commands and results', permission: P.DEVICES_MANAGE }, async ({ ctx, params }) => BridgeCommand.find({ tenantId: ctx.tenantId, deviceId: params.id }).sort({ createdAt: -1 }).limit(50).lean());

m.route({ method: 'post', path: '/devices/:id/enroll', summary: 'Start enrolment of an employee on a device (consent required)', permission: P.BIOMETRIC_ENROLL, feature: 'biometrics', body: z.object({ employeeId: zId, fingerIndex: z.number().int().min(0).max(9).default(0) }), status: 201 }, async ({ ctx, params, body, req }) => {
  const [d, e] = await Promise.all([BiometricDevice.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id }).lean(), Employee.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: body.employeeId }).lean()]);
  if (!d) throw notFound('Device');
  if (!e) throw notFound('Employee');
  if (!e.biometricConsent?.given) throw new AppError(409, 'CONSENT_REQUIRED', 'Record the employee’s informed consent before enrolment, or use PIN/manual attendance instead.');
  if (!e.deviceUserCode) throw badRequest('Assign the employee a device user code first');
  const ref = await BiometricEnrollmentReference.create({ tenantId: ctx.tenantId, employeeId: e._id, deviceId: d._id, deviceUserCode: e.deviceUserCode, fingerIndex: body.fingerIndex, storage: d.vendor === 'secugen' ? 'bridge_local' : 'device', status: d.vendor === 'mock' ? 'enrolled' : 'pending', consentAt: e.biometricConsent.at, enrolledBy: ctx.userId });
  if (d.bridgeId) await BridgeCommand.create({ tenantId: ctx.tenantId, bridgeId: d.bridgeId, deviceId: d._id, type: 'enroll_user', payload: { deviceUserCode: e.deviceUserCode, name: e.name.slice(0, 24), fingerIndex: body.fingerIndex, enrollmentId: String(ref._id) }, requestedBy: ctx.userId });
  await audit(ctx, { action: 'biometric.enroll_requested', entity: 'Employee', entityId: e._id, meta: { device: String(d._id) } }, req);
  return ref;
});
m.route({ method: 'get', path: '/enrollments', summary: 'Enrolment references (no biometric data)', permission: [P.BIOMETRIC_ENROLL, P.DEVICES_MANAGE] }, async ({ ctx }) => BiometricEnrollmentReference.find({ tenantId: ctx.tenantId }).sort({ createdAt: -1 }).limit(500).lean());

// ── Shifts ──
const zShift = z.object({ name: z.string().min(1).max(40), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), breakMinutes: z.number().int().min(0).max(240).optional(), graceMinutes: z.number().int().min(0).max(120).optional(), days: z.array(z.number().int().min(0).max(6)).optional() });
m.route({ method: 'get', path: '/shifts', summary: 'Shifts', permission: [P.ATTENDANCE_VIEW, P.STAFF_VIEW] }, async ({ ctx }) => Shift.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).lean());
m.route({ method: 'post', path: '/shifts', summary: 'Create shift', permission: P.ATTENDANCE_MANAGE, body: zShift, status: 201 }, async ({ ctx, body }) => Shift.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId }));
m.route({ method: 'post', path: '/shifts/assign', summary: 'Assign shifts to employees for dates', permission: P.ATTENDANCE_MANAGE, body: z.object({ shiftId: zId, employeeIds: z.array(zId).min(1), dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(62) }) }, async ({ ctx, body }) => {
  if (!(await Shift.exists({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: body.shiftId }))) throw notFound('Shift');
  let n = 0;
  for (const employeeId of body.employeeIds) for (const date of body.dates) {
    await ShiftAssignment.updateOne({ tenantId: ctx.tenantId, employeeId, date }, { $set: { branchId: ctx.branchId, shiftId: body.shiftId } }, { upsert: true });
    n++;
  }
  return { assigned: n };
});

// ── Attendance events ──
m.route({ method: 'get', path: '/attendance/events', summary: 'Raw attendance events', permission: P.ATTENDANCE_VIEW, query: z.object({ from: z.coerce.date(), to: z.coerce.date(), employeeId: zId.optional() }) }, async ({ ctx, query }) =>
  AttendanceEvent.find({ tenantId: ctx.tenantId, branchId: ctx.branchId, at: { $gte: query.from, $lte: query.to }, ...(query.employeeId ? { employeeId: query.employeeId } : {}) }).sort({ at: -1 }).limit(2000).lean(),
);
/** Alternative (non-biometric) attendance: employee clocks in at the POS with their user PIN. */
m.route({ method: 'post', path: '/attendance/pin', summary: 'Clock in/out with POS PIN (non-biometric alternative)', permission: P.ORDERS_VIEW, body: z.object({ employeeNo: z.string(), pin: z.string().regex(/^\d{4,8}$/), type: z.enum(['clock_in', 'clock_out', 'break_start', 'break_end']) }), status: 201 }, async ({ ctx, body }) => {
  const e = await Employee.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, employeeNo: body.employeeNo, active: true }).lean();
  const u = e?.userId ? await User.findOne({ tenantId: ctx.tenantId, _id: e.userId }).select('+pinHash').lean() : null;
  if (!e || !u || !(await verifyPassword(u.pinHash, body.pin))) throw unauthorized('Employee number or PIN is incorrect');
  const at = new Date();
  const ev = await AttendanceEvent.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, employeeId: e._id, type: body.type, at, source: 'pos_pin', verifyMode: 'pin', dedupeKey: `pin:${e._id}:${Math.floor(at.getTime() / 60000)}:${body.type}` }).catch((err) => {
    if (err.code === 11000) throw conflict('Already recorded this minute');
    throw err;
  });
  return ev;
});
m.route({ method: 'post', path: '/attendance/corrections', summary: 'Request a manual attendance correction (needs approval)', permission: P.ATTENDANCE_MANAGE, body: z.object({ employeeId: zId, type: z.enum(['clock_in', 'clock_out', 'break_start', 'break_end']), at: z.coerce.date(), reason: z.string().min(3).max(300) }), status: 201 }, async ({ ctx, body, req }) => {
  if (!(await Employee.exists({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: body.employeeId }))) throw notFound('Employee');
  const ev = await AttendanceEvent.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, employeeId: body.employeeId, type: body.type, at: body.at, source: 'correction', dedupeKey: `corr:${body.employeeId}:${body.at.getTime()}:${body.type}`, correction: { reason: body.reason, requestedBy: ctx.userId, status: 'pending' } });
  await audit(ctx, { action: 'attendance.correction_requested', entity: 'AttendanceEvent', entityId: ev._id, reason: body.reason }, req);
  return ev;
});
m.route({ method: 'post', path: '/attendance/corrections/:id/decision', summary: 'Approve/reject a correction', permission: P.ATTENDANCE_APPROVE, body: z.object({ approve: z.boolean() }) }, async ({ ctx, params, body, req }) => {
  const ev = await AttendanceEvent.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id, 'correction.status': 'pending' });
  if (!ev) throw notFound('Pending correction');
  if (String(ev.correction?.requestedBy) === String(ctx.userId)) throw new AppError(403, 'FORBIDDEN', 'Corrections must be approved by a different person');
  ev.set('correction.status', body.approve ? 'approved' : 'rejected');
  ev.set('correction.approvedBy', ctx.userId);
  await ev.save();
  await audit(ctx, { action: `attendance.correction_${body.approve ? 'approved' : 'rejected'}`, entity: 'AttendanceEvent', entityId: ev._id, reason: ev.correction?.reason ?? undefined }, req);
  return ev;
});
m.route({ method: 'get', path: '/attendance/report', summary: 'Daily attendance report (JSON or CSV)', permission: [P.ATTENDANCE_VIEW, P.REPORTS_STAFF], raw: true, query: z.object({ from: z.coerce.date(), to: z.coerce.date(), employeeId: zId.optional(), format: z.enum(['json', 'csv']).default('json') }) }, async ({ ctx, query, res }) => {
  if (query.to.getTime() - query.from.getTime() > 93 * 86400_000) throw badRequest('Maximum range is 93 days');
  const rows = await attendanceReport(ctx.tenantId, ctx.branchId, query.from, query.to, query.employeeId);
  if (query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${query.from.toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows as never));
    return;
  }
  const summary = new Map<string, { employeeName: string; days: number; workedMinutes: number; lateDays: number; overtimeMinutes: number; missingClockOuts: number }>();
  for (const r of rows) {
    const s = summary.get(r.employeeId) ?? { employeeName: r.employeeName, days: 0, workedMinutes: 0, lateDays: 0, overtimeMinutes: 0, missingClockOuts: 0 };
    s.days++;
    s.workedMinutes += r.workedMinutes;
    s.lateDays += r.lateMinutes > 0 ? 1 : 0;
    s.overtimeMinutes += r.overtimeMinutes;
    s.missingClockOuts += r.missingClockOut ? 1 : 0;
    summary.set(r.employeeId, s);
  }
  res.json({ data: { rows, summary: [...summary.entries()].map(([employeeId, s]) => ({ employeeId, ...s })) } });
});

// ── Bridge API (authenticated with the bridge token, not a user session) ──
async function bridgeAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.header('x-bridge-token');
    if (!token || !token.startsWith('cbr_')) throw unauthorized('Bridge token required');
    // Lookup by token hash spans tenants by design; the tenant is then taken from the bridge record.
    const b = await BridgeAgent.findOne({ tokenHash: sha256(token), active: true }).setOptions({ skipTenantGuard: true }).lean();
    if (!b) throw unauthorized('Invalid bridge token');
    req.bridge = { id: b._id, tenantId: b.tenantId as Types.ObjectId, branchId: b.branchId as Types.ObjectId };
    next();
  } catch (e) {
    next(e);
  }
}
const bm = createModule('/bridge', 'Bridge');

bm.route({ method: 'post', path: '/heartbeat', summary: 'Bridge heartbeat with diagnostics and device status', auth: 'public', middleware: [bridgeAuth], body: z.object({ version: z.string().max(20), capabilities: z.array(z.string().max(30)).max(20), diagnostics: z.record(z.string(), z.unknown()).optional(), devices: z.array(z.object({ id: zId, status: z.enum(['online', 'offline', 'error']), error: z.string().max(300).optional(), clockDriftSeconds: z.number().optional() })).max(50).optional(), printers: z.array(z.object({ id: zId, status: z.enum(['ok', 'error']), error: z.string().max(300).optional() })).max(50).optional() }) }, async ({ req, body }) => {
  const b = req.bridge!;
  await BridgeAgent.updateOne({ tenantId: b.tenantId, _id: b.id }, { $set: { lastSeenAt: new Date(), version: body.version, capabilities: body.capabilities, diagnostics: body.diagnostics } });
  for (const d of body.devices ?? []) {
    const prev = await BiometricDevice.findOneAndUpdate({ tenantId: b.tenantId, bridgeId: b.id, _id: d.id }, { $set: { status: d.status, lastError: d.error, clockDriftSeconds: d.clockDriftSeconds, ...(d.status === 'online' ? { lastSeenAt: new Date() } : {}) } });
    if (prev && prev.status === 'online' && d.status !== 'online') {
      await notify(b.tenantId, { event: 'integration_failure', channel: 'email', to: (await Tenant.findById(b.tenantId).lean())?.contactEmail ?? '', vars: { integration: `Device ${prev.name}`, error: d.error ?? 'Disconnected', time: new Date().toISOString() }, dedupeKey: `devdown:${d.id}:${new Date().toISOString().slice(0, 13)}` }).catch(() => undefined);
    }
  }
  for (const p of body.printers ?? []) await Printer.updateOne({ tenantId: b.tenantId, _id: p.id }, { $set: { lastStatus: p.status, lastError: p.error } });
  return { ok: true, serverTime: new Date().toISOString() };
});

bm.route({ method: 'get', path: '/poll', summary: 'Fetch configuration, print jobs and device commands for this bridge', auth: 'public', middleware: [bridgeAuth] }, async ({ req }) => {
  const b = req.bridge!;
  const printers = await Printer.find({ tenantId: b.tenantId, bridgeId: b.id, active: true }).lean();
  const [jobs, commands, devices] = await Promise.all([
    PrintJob.find({ tenantId: b.tenantId, printerId: { $in: printers.map((p) => p._id) }, status: 'queued' }).sort({ createdAt: 1 }).limit(20).lean(),
    BridgeCommand.find({ tenantId: b.tenantId, bridgeId: b.id, status: 'queued' }).sort({ createdAt: 1 }).limit(20).lean(),
    BiometricDevice.find({ tenantId: b.tenantId, bridgeId: b.id, active: true }).lean(),
  ]);
  await PrintJob.updateMany({ tenantId: b.tenantId, _id: { $in: jobs.map((j) => j._id) } }, { $set: { status: 'sent' }, $inc: { attempts: 1 } });
  await BridgeCommand.updateMany({ tenantId: b.tenantId, _id: { $in: commands.map((c) => c._id) } }, { $set: { status: 'sent' } });
  return { printers, jobs, commands, devices: devices.map((d) => ({ id: d._id, vendor: d.vendor, deviceType: d.deviceType, model: d.model, connection: d.connection, host: d.host, port: d.port, timezone: d.timezone, lastSyncAt: d.lastSyncAt })) };
});

bm.route({ method: 'post', path: '/print-jobs/:id/result', summary: 'Report a print job result', auth: 'public', middleware: [bridgeAuth], body: z.object({ ok: z.boolean(), error: z.string().max(300).optional() }) }, async ({ req, params, body }) => {
  const b = req.bridge!;
  const job = await PrintJob.findOneAndUpdate({ tenantId: b.tenantId, _id: params.id }, { $set: { status: body.ok ? 'printed' : 'failed', error: body.error } }, { new: true });
  if (!job) throw notFound('Print job');
  await Printer.updateOne({ tenantId: b.tenantId, _id: job.printerId }, { $set: body.ok ? { lastPrintAt: new Date(), lastStatus: 'ok', lastError: null } : { lastStatus: 'error', lastError: body.error } });
  return { ok: true };
});

bm.route({ method: 'post', path: '/commands/:id/result', summary: 'Report a device command result', auth: 'public', middleware: [bridgeAuth], body: z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(500).optional() }) }, async ({ req, params, body }) => {
  const b = req.bridge!;
  const cmd = await BridgeCommand.findOneAndUpdate({ tenantId: b.tenantId, bridgeId: b.id, _id: params.id }, { $set: { status: body.ok ? 'done' : 'failed', result: body.result, error: body.error } }, { new: true });
  if (!cmd) throw notFound('Command');
  const enrollmentId = (cmd.payload as { enrollmentId?: string } | undefined)?.enrollmentId;
  if (cmd.type === 'enroll_user' && enrollmentId) await BiometricEnrollmentReference.updateOne({ tenantId: b.tenantId, _id: enrollmentId }, { $set: { status: body.ok ? 'enrolled' : 'failed' } });
  if (cmd.type === 'delete_user' && enrollmentId && body.ok) await BiometricEnrollmentReference.updateOne({ tenantId: b.tenantId, _id: enrollmentId }, { $set: { status: 'deleted', live: false, deletedAt: new Date() } });
  if (cmd.deviceId && ['sync_time', 'device_test'].includes(cmd.type)) await BiometricDevice.updateOne({ tenantId: b.tenantId, _id: cmd.deviceId }, { $set: body.ok ? { status: 'online', lastSeenAt: new Date(), lastError: null } : { status: 'error', lastError: body.error } });
  return { ok: true };
});

/** Ingest attendance punches pulled from a device. Dedupe key = device + user code + timestamp, so re-pulling logs is safe. */
bm.route({ method: 'post', path: '/attendance', summary: 'Ingest attendance events from a device', auth: 'public', middleware: [bridgeAuth], body: z.object({ deviceId: zId, events: z.array(z.object({ userCode: z.string().max(20), at: z.coerce.date(), punch: z.enum(['clock_in', 'clock_out', 'break_start', 'break_end', 'unknown']).default('unknown'), verifyMode: z.string().max(20).optional() })).max(5000) }) }, async ({ req, body }) => {
  const b = req.bridge!;
  const device = await BiometricDevice.findOne({ tenantId: b.tenantId, bridgeId: b.id, _id: body.deviceId }).lean();
  if (!device) throw notFound('Device');
  const now = Date.now();
  const codes = [...new Set(body.events.map((e) => e.userCode))];
  const employees = await Employee.find({ tenantId: b.tenantId, deviceUserCode: { $in: codes } }).lean();
  let inserted = 0;
  let duplicates = 0;
  let rejected = 0;
  let latest = device.lastSyncAt ?? new Date(0);
  for (const e of body.events) {
    // Reject impossible timestamps (device clock badly wrong) rather than polluting reports.
    if (e.at.getTime() > now + 10 * 60_000 || e.at.getTime() < now - 400 * 86400_000) {
      rejected++;
      continue;
    }
    const emp = employees.find((x) => x.deviceUserCode === e.userCode);
    try {
      await AttendanceEvent.create({ tenantId: b.tenantId, branchId: device.branchId, employeeId: emp?._id, deviceId: device._id, deviceUserCode: e.userCode, type: e.punch, at: e.at, source: 'device', verifyMode: e.verifyMode, unmatched: !emp, dedupeKey: `dev:${device._id}:${e.userCode}:${e.at.getTime()}` });
      inserted++;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) duplicates++;
      else throw err;
    }
    if (e.at > latest) latest = e.at;
  }
  await BiometricDevice.updateOne({ tenantId: b.tenantId, _id: device._id }, { $set: { lastSyncAt: latest, status: 'online', lastSeenAt: new Date() } });
  return { inserted, duplicates, rejected };
});

export { bm as bridgeModule };
export default m;
