import { Schema, model } from 'mongoose';
import { schemaOpts, tenantRef, branchRef } from './common';

const diningAreaSchema = new Schema(
  { tenantId: tenantRef, branchId: branchRef, name: { type: String, required: true }, sortOrder: { type: Number, default: 0 } },
  schemaOpts,
);
export const DiningArea = model('DiningArea', diningAreaSchema);

const tableSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    areaId: { type: Schema.Types.ObjectId, ref: 'DiningArea' },
    number: { type: String, required: true },
    capacity: { type: Number, default: 4 },
    shape: { type: String, enum: ['square', 'round', 'rect'], default: 'square' },
    layout: { x: { type: Number, default: 0 }, y: { type: Number, default: 0 }, w: { type: Number, default: 1 }, h: { type: Number, default: 1 } },
    status: { type: String, enum: ['available', 'occupied', 'reserved', 'cleaning'], default: 'available' },
    waiterId: { type: Schema.Types.ObjectId, ref: 'User' },
    occupiedSince: Date,
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
tableSchema.index({ tenantId: 1, branchId: 1, number: 1 }, { unique: true });
export const Table = model('Table', tableSchema);

const reservationSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    code: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, required: true },
    phone: String,
    email: String,
    partySize: { type: Number, required: true, min: 1 },
    startsAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 90 },
    tableIds: [{ type: Schema.Types.ObjectId, ref: 'Table' }],
    specialRequests: String,
    status: { type: String, enum: ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'], default: 'confirmed' },
    source: { type: String, enum: ['phone', 'walk_in', 'online', 'staff'], default: 'staff' },
    reminderSentAt: Date,
    createdBy: Schema.Types.ObjectId,
  },
  schemaOpts,
);
reservationSchema.index({ tenantId: 1, code: 1 }, { unique: true });
export const Reservation = model('Reservation', reservationSchema);
