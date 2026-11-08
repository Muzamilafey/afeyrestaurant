import { z } from 'zod';
import { createModule, zId, zMoney } from '../../http/route';
import { AccommodationRoom, AccommodationStay, Tenant } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { audit } from '../../services/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { emitBranch } from '../../realtime/bus';

const m = createModule('/accommodation', 'Accommodation');

async function assertEnabled(tenantId: unknown) {
  const tenant = await Tenant.findById(tenantId).select('settings.accommodationEnabled').lean();
  if (tenant?.settings?.accommodationEnabled !== true) throw forbidden('Accommodation is disabled for this business');
}

const zRoom = z.object({
  number: z.string().trim().min(1).max(20),
  roomType: z.string().trim().min(1).max(60).default('Standard'),
  capacity: z.number().int().min(1).max(20).default(2),
  nightlyRate: zMoney.default(0),
  active: z.boolean().optional(),
});

const zStay = z.object({
  roomId: zId,
  guestName: z.string().trim().min(1).max(100),
  phone: z.string().max(30).optional(),
  email: z.email().optional(),
  guestCount: z.number().int().min(1).max(20),
  checkIn: z.coerce.date(),
  checkOut: z.coerce.date(),
  notes: z.string().max(500).optional(),
});

function nightsBetween(checkIn: Date, checkOut: Date) {
  return Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
}

async function checkAvailability(tenantId: unknown, branchId: unknown, roomId: unknown, checkIn: Date, checkOut: Date, excludeId?: unknown) {
  const clash = await AccommodationStay.findOne({
    tenantId,
    branchId,
    roomId,
    status: { $in: ['reserved', 'checked_in'] },
    $or: [
      { status: 'checked_in' },
      { status: 'reserved', checkIn: { $lt: checkOut }, checkOut: { $gt: checkIn } },
    ],
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).lean();
  if (clash) throw conflict('This room is already booked for part of those dates', 'ROOM_UNAVAILABLE');
}

m.route({ method: 'get', path: '/rooms', summary: 'List accommodation rooms', permission: P.ACCOMMODATION_VIEW }, async ({ ctx }) => {
  await assertEnabled(ctx.tenantId);
  return AccommodationRoom.find({ tenantId: ctx.tenantId, branchId: ctx.branchId }).sort({ number: 1 }).lean();
});

m.route({ method: 'post', path: '/rooms', summary: 'Add an accommodation room', permission: P.ACCOMMODATION_MANAGE, body: zRoom, status: 201 }, async ({ ctx, body, req }) => {
  await assertEnabled(ctx.tenantId);
  if (await AccommodationRoom.exists({ tenantId: ctx.tenantId, branchId: ctx.branchId, number: body.number })) throw conflict('A room with this number already exists', 'ROOM_EXISTS');
  const room = await AccommodationRoom.create({ ...body, tenantId: ctx.tenantId, branchId: ctx.branchId });
  await audit(ctx, { action: 'accommodation.room_created', entity: 'AccommodationRoom', entityId: room._id, after: body }, req);
  emitBranch(ctx.tenantId, ctx.branchId, 'accommodation.updated', { roomId: String(room._id) });
  return room;
});

m.route({ method: 'patch', path: '/rooms/:id', summary: 'Update an accommodation room', permission: P.ACCOMMODATION_MANAGE, body: zRoom.partial() }, async ({ ctx, params, body, req }) => {
  await assertEnabled(ctx.tenantId);
  const room = await AccommodationRoom.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!room) throw notFound('Room');
  if (body.number && body.number !== room.number && await AccommodationRoom.exists({ tenantId: ctx.tenantId, branchId: ctx.branchId, number: body.number, _id: { $ne: room._id } })) throw conflict('A room with this number already exists', 'ROOM_EXISTS');
  const before = room.toObject();
  room.set(body);
  await room.save();
  await audit(ctx, { action: 'accommodation.room_updated', entity: 'AccommodationRoom', entityId: room._id, before, after: body }, req);
  emitBranch(ctx.tenantId, ctx.branchId, 'accommodation.updated', { roomId: String(room._id) });
  return room;
});

m.route({ method: 'get', path: '/stays', summary: 'List accommodation bookings', permission: P.ACCOMMODATION_VIEW, query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), status: z.string().optional() }) }, async ({ ctx, query }) => {
  await assertEnabled(ctx.tenantId);
  const from = query.from ?? new Date(Date.now() - 7 * 86_400_000);
  const to = query.to ?? new Date(Date.now() + 90 * 86_400_000);
  return AccommodationStay.find({
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    $or: [
      { status: 'checked_in' },
      { checkIn: { $lt: to }, checkOut: { $gt: from } },
    ],
    ...(query.status ? { status: { $in: query.status.split(',') } } : {}),
  }).sort({ checkIn: 1 }).limit(500).lean();
});

m.route({ method: 'post', path: '/stays', summary: 'Book a room for a guest', permission: P.ACCOMMODATION_MANAGE, body: zStay, status: 201 }, async ({ ctx, body, req }) => {
  await assertEnabled(ctx.tenantId);
  if (body.checkOut <= body.checkIn) throw badRequest('Check-out must be after check-in');
  const room = await AccommodationRoom.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: body.roomId, active: true }).lean();
  if (!room) throw notFound('Active room');
  if (body.guestCount > room.capacity) throw badRequest(`This room can hold up to ${room.capacity} guests`);
  await checkAvailability(ctx.tenantId, ctx.branchId, room._id, body.checkIn, body.checkOut);
  const nightlyRate = room.nightlyRate ?? 0;
  const stay = await AccommodationStay.create({
    ...body,
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    nightlyRate,
    total: nightsBetween(body.checkIn, body.checkOut) * nightlyRate,
    createdBy: ctx.userId,
  });
  await audit(ctx, { action: 'accommodation.stay_booked', entity: 'AccommodationStay', entityId: stay._id, after: { roomId: room._id, guestName: body.guestName, checkIn: body.checkIn, checkOut: body.checkOut, total: stay.total } }, req);
  emitBranch(ctx.tenantId, ctx.branchId, 'accommodation.updated', { stayId: String(stay._id) });
  return stay;
});

m.route({ method: 'post', path: '/stays/:id/status', summary: 'Check a guest in or out, or cancel a booking', permission: P.ACCOMMODATION_MANAGE, body: z.object({ status: z.enum(['checked_in', 'checked_out', 'cancelled']) }) }, async ({ ctx, params, body, req }) => {
  await assertEnabled(ctx.tenantId);
  const stay = await AccommodationStay.findOne({ tenantId: ctx.tenantId, branchId: ctx.branchId, _id: params.id });
  if (!stay) throw notFound('Booking');
  const before = stay.status;
  if (body.status === 'checked_in') {
    if (stay.status !== 'reserved') throw badRequest('Only reserved bookings can be checked in');
    stay.set({ status: 'checked_in', checkedInAt: new Date(), checkedInBy: ctx.userId });
  } else if (body.status === 'checked_out') {
    if (stay.status !== 'checked_in') throw badRequest('Only checked-in guests can check out');
    stay.set({ status: 'checked_out', checkedOutAt: new Date(), checkedOutBy: ctx.userId });
  } else {
    if (stay.status !== 'reserved') throw badRequest('Only reserved bookings can be cancelled');
    stay.status = 'cancelled';
  }
  await stay.save();
  await audit(ctx, { action: `accommodation.${body.status}`, entity: 'AccommodationStay', entityId: stay._id, before: { status: before }, after: { status: stay.status } }, req);
  emitBranch(ctx.tenantId, ctx.branchId, 'accommodation.updated', { stayId: String(stay._id) });
  return stay;
});

export default m;
