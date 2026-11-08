import { Schema, model } from 'mongoose';
import { schemaOpts, tenantRef, branchRef, money } from './common';

const accommodationRoomSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    number: { type: String, required: true, trim: true },
    roomType: { type: String, required: true, trim: true, default: 'Standard' },
    capacity: { type: Number, required: true, min: 1, default: 2 },
    nightlyRate: money,
    active: { type: Boolean, default: true },
  },
  schemaOpts,
);
accommodationRoomSchema.index({ tenantId: 1, branchId: 1, number: 1 }, { unique: true });
export const AccommodationRoom = model('AccommodationRoom', accommodationRoomSchema);

const accommodationStaySchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    roomId: { type: Schema.Types.ObjectId, ref: 'AccommodationRoom', required: true },
    guestName: { type: String, required: true, trim: true },
    phone: String,
    email: String,
    guestCount: { type: Number, required: true, min: 1 },
    checkIn: { type: Date, required: true, index: true },
    checkOut: { type: Date, required: true },
    nightlyRate: money,
    total: money,
    notes: String,
    status: { type: String, enum: ['reserved', 'checked_in', 'checked_out', 'cancelled'], default: 'reserved', index: true },
    checkedInAt: Date,
    checkedInBy: Schema.Types.ObjectId,
    checkedOutAt: Date,
    checkedOutBy: Schema.Types.ObjectId,
    createdBy: Schema.Types.ObjectId,
  },
  schemaOpts,
);
accommodationStaySchema.index({ tenantId: 1, branchId: 1, roomId: 1, checkIn: 1, checkOut: 1 });
accommodationStaySchema.index({ tenantId: 1, branchId: 1, status: 1, checkIn: 1 });
export const AccommodationStay = model('AccommodationStay', accommodationStaySchema);
