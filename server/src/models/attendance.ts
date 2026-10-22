import { Schema, model } from 'mongoose';
import { schemaOpts, tenantRef, branchRef } from './common';

export const DEVICE_VENDORS = ['zkteco', 'secugen', 'mock'] as const;

const biometricDeviceSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    name: { type: String, required: true },
    vendor: { type: String, enum: DEVICE_VENDORS, required: true },
    /** zkteco_terminal: standalone/network terminal (ZK protocol over TCP/UDP 4370). secugen_usb: reader on a PC via the bridge. */
    deviceType: { type: String, enum: ['zkteco_terminal', 'secugen_usb', 'mock'], required: true },
    model: String,
    serialNumber: String,
    connection: { type: String, enum: ['tcp', 'udp', 'usb_bridge', 'mock'], required: true },
    host: String,
    port: { type: Number, default: 4370 },
    /** Bridge agent that reaches the device on the LAN / USB. */
    bridgeId: Schema.Types.ObjectId,
    timezone: { type: String, default: 'Africa/Nairobi' },
    /** Only set true after a physical test on this model. */
    verified: { type: Boolean, default: false },
    verificationNotes: String,
    status: { type: String, enum: ['unknown', 'online', 'offline', 'error'], default: 'unknown' },
    lastSeenAt: Date,
    lastSyncAt: Date,
    lastError: String,
    clockDriftSeconds: Number,
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
export const BiometricDevice = model('BiometricDevice', biometricDeviceSchema);

/**
 * Reference to an enrollment held on a device or by the bridge's SDK. Biometric templates are NOT stored
 * in the cloud database by default — only the device user code and template slot metadata.
 */
const enrollmentRefSchema = new Schema(
  {
    tenantId: tenantRef,
    employeeId: { type: Schema.Types.ObjectId, required: true, index: true },
    deviceId: { type: Schema.Types.ObjectId, required: true },
    deviceUserCode: { type: String, required: true },
    fingerIndex: Number,
    storage: { type: String, enum: ['device', 'bridge_local'], default: 'device' },
    status: { type: String, enum: ['pending', 'enrolled', 'failed', 'deleted'], default: 'pending' },
    consentAt: Date,
    enrolledBy: Schema.Types.ObjectId,
    /** False once deleted; keeps the uniqueness rule to live enrolments only. */
    live: { type: Boolean, default: true },
    deletedAt: Date,
    deletedBy: Schema.Types.ObjectId,
  },
  schemaOpts,
);
enrollmentRefSchema.index({ tenantId: 1, deviceId: 1, deviceUserCode: 1, fingerIndex: 1 }, { unique: true, partialFilterExpression: { live: true } });
export const BiometricEnrollmentReference = model('BiometricEnrollmentReference', enrollmentRefSchema);

const shiftSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    name: { type: String, required: true },
    start: { type: String, required: true }, // HH:mm
    end: { type: String, required: true },
    breakMinutes: { type: Number, default: 30 },
    graceMinutes: { type: Number, default: 10 },
    days: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] },
  },
  schemaOpts,
);
export const Shift = model('Shift', shiftSchema);

const shiftAssignmentSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    employeeId: { type: Schema.Types.ObjectId, required: true },
    shiftId: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD (branch local)
  },
  schemaOpts,
);
shiftAssignmentSchema.index({ tenantId: 1, employeeId: 1, date: 1 }, { unique: true });
export const ShiftAssignment = model('ShiftAssignment', shiftAssignmentSchema);

const attendanceEventSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    employeeId: { type: Schema.Types.ObjectId, index: true },
    deviceId: Schema.Types.ObjectId,
    deviceUserCode: String,
    type: { type: String, enum: ['clock_in', 'clock_out', 'break_start', 'break_end', 'unknown'], required: true },
    at: { type: Date, required: true },
    source: { type: String, enum: ['device', 'bridge', 'manual', 'pos_pin', 'correction'], required: true },
    verifyMode: String, // fingerprint | card | password | face
    /** device+user+timestamp — makes re-syncing logs from a device idempotent. */
    dedupeKey: { type: String, required: true },
    unmatched: { type: Boolean, default: false },
    correction: { reason: String, requestedBy: Schema.Types.ObjectId, approvedBy: Schema.Types.ObjectId, status: { type: String, enum: ['pending', 'approved', 'rejected'] } },
    voided: { type: Boolean, default: false },
  },
  schemaOpts,
);
attendanceEventSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
attendanceEventSchema.index({ tenantId: 1, branchId: 1, at: -1 });
export const AttendanceEvent = model('AttendanceEvent', attendanceEventSchema);
