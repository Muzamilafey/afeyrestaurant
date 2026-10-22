import type { Server } from 'socket.io';
import type { Types } from 'mongoose';

let io: Server | null = null;
export const setIo = (s: Server | null) => {
  io = s;
};

/** Rooms are always tenant-prefixed so events can never cross tenants. */
export const branchRoom = (tenantId: Types.ObjectId | string, branchId: Types.ObjectId | string) => `t:${tenantId}:b:${branchId}`;
export const stationRoom = (tenantId: Types.ObjectId | string, branchId: Types.ObjectId | string, station: string) => `t:${tenantId}:b:${branchId}:s:${station}`;

export function emitBranch(tenantId: Types.ObjectId | string, branchId: Types.ObjectId | string, event: string, payload: unknown) {
  io?.to(branchRoom(tenantId, branchId)).emit(event, payload);
}
export function emitStation(tenantId: Types.ObjectId | string, branchId: Types.ObjectId | string, station: string, event: string, payload: unknown) {
  io?.to(stationRoom(tenantId, branchId, station)).emit(event, payload);
}
