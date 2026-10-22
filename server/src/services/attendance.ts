import type { Types } from 'mongoose';
import { AttendanceEvent, Employee, Shift, ShiftAssignment, Tenant } from '../models';
import { localParts } from './pricing';

export interface DayRecord {
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  date: string;
  firstIn: Date | null;
  lastOut: Date | null;
  workedMinutes: number;
  breakMinutes: number;
  scheduledMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  missingClockOut: boolean;
  events: number;
  shift: string | null;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Build daily attendance records from raw events. Devices that do not report punch type ("unknown") are
 * interpreted as first punch = in, last punch = out. Explicit break events are used when present,
 * otherwise the shift's unpaid break applies.
 */
export async function attendanceReport(tenantId: Types.ObjectId, branchId: Types.ObjectId, from: Date, to: Date, employeeId?: string): Promise<DayRecord[]> {
  const tenant = await Tenant.findById(tenantId).lean();
  const tz = tenant?.settings?.timezone ?? 'Africa/Nairobi';
  const empFilter: Record<string, unknown> = { tenantId, branchId };
  if (employeeId) empFilter._id = employeeId;
  const [employees, events, shifts] = await Promise.all([
    Employee.find(empFilter).lean(),
    AttendanceEvent.find({ tenantId, branchId, at: { $gte: from, $lte: to }, voided: { $ne: true }, employeeId: { $ne: null }, $or: [{ 'correction.status': { $exists: false } }, { 'correction.status': 'approved' }] }).sort({ at: 1 }).lean(),
    Shift.find({ tenantId, branchId }).lean(),
  ]);
  const assignments = await ShiftAssignment.find({ tenantId, branchId, employeeId: { $in: employees.map((e) => e._id) } }).lean();
  const out: DayRecord[] = [];
  const byKey = new Map<string, typeof events>();
  for (const e of events) {
    const date = localParts(tz, e.at).date;
    const k = `${e.employeeId}|${date}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(e);
  }
  for (const [k, evs] of byKey) {
    const [empId, date] = k.split('|');
    const emp = employees.find((x) => String(x._id) === empId);
    if (!emp) continue;
    const ins = evs.filter((e) => e.type === 'clock_in');
    const outs = evs.filter((e) => e.type === 'clock_out');
    const firstIn = ins[0]?.at ?? evs[0].at;
    let lastOut: Date | null = outs.length ? outs[outs.length - 1].at : evs.length > 1 ? evs[evs.length - 1].at : null;
    if (lastOut && lastOut <= firstIn) lastOut = null;
    const lastIsIn = evs[evs.length - 1].type === 'clock_in' && evs.length > 1;
    const assignment = assignments.find((a) => String(a.employeeId) === empId && a.date === date);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const shift = assignment ? shifts.find((s) => String(s._id) === String(assignment.shiftId)) : shifts.find((s) => s.days?.includes(dow) && shifts.length === 1);
    let breakMinutes = 0;
    const bs = evs.filter((e) => e.type === 'break_start');
    const be = evs.filter((e) => e.type === 'break_end');
    for (let i = 0; i < Math.min(bs.length, be.length); i++) breakMinutes += Math.max(0, (be[i].at.getTime() - bs[i].at.getTime()) / 60000);
    if (!bs.length && shift) breakMinutes = shift.breakMinutes ?? 0;
    const gross = lastOut ? (lastOut.getTime() - firstIn.getTime()) / 60000 : 0;
    const worked = Math.max(0, Math.round(gross - (lastOut ? breakMinutes : 0)));
    let scheduled = 0;
    let late = 0;
    let early = 0;
    if (shift) {
      const s = minutesOf(shift.start);
      let e = minutesOf(shift.end);
      if (e <= s) e += 1440;
      scheduled = e - s - (shift.breakMinutes ?? 0);
      const inLocal = minutesOf(localParts(tz, firstIn).time);
      late = Math.max(0, inLocal - s - (shift.graceMinutes ?? 0));
      if (lastOut) {
        let outLocal = minutesOf(localParts(tz, lastOut).time);
        if (outLocal < s) outLocal += 1440;
        early = Math.max(0, e - outLocal);
      }
    }
    out.push({
      employeeId: empId, employeeName: emp.name, employeeNo: emp.employeeNo, date, firstIn, lastOut, workedMinutes: worked, breakMinutes: Math.round(breakMinutes),
      scheduledMinutes: scheduled, lateMinutes: late, earlyLeaveMinutes: early, overtimeMinutes: shift && lastOut ? Math.max(0, worked - scheduled) : 0,
      missingClockOut: !lastOut || lastIsIn, events: evs.length, shift: shift?.name ?? null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName));
}

export function toCsv(rows: Array<Record<string, unknown>>) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    let s = v instanceof Date ? v.toISOString() : v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
