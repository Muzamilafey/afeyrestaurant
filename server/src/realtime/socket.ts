import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { verifyAccessToken } from '../auth/tokens';
import { buildContext } from '../middleware/auth';
import { branchRoom, setIo, stationRoom } from './bus';
import { PERMISSIONS as P } from '../auth/permissions';
import type { RequestContext } from '../http/context';
import { logger } from '../lib/logger';

/**
 * Socket.IO server. Clients authenticate with their access token and may only join rooms for their own
 * tenant and assigned branches; station rooms additionally require kitchen/bar view permission.
 */
export function attachRealtime(server: HttpServer) {
  const io = new Server(server, { path: '/api/v1/realtime', cors: { origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true } });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('unauthorized');
      const claims = verifyAccessToken(token);
      const fakeReq = { header: () => undefined, hostTenantId: null } as never;
      socket.data.ctx = await buildContext(claims.sub, claims.ver, fakeReq);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    const ctx = socket.data.ctx as RequestContext;
    socket.on('join', (msg: { branchId?: string; stations?: string[] }, ack?: (r: unknown) => void) => {
      if (!ctx.tenantId || !msg?.branchId || !Types.ObjectId.isValid(msg.branchId) || !ctx.allowedBranchIds.some((b) => String(b) === msg.branchId)) return ack?.({ ok: false, error: 'forbidden' });
      for (const room of socket.rooms) if (room !== socket.id) socket.leave(room);
      socket.join(branchRoom(ctx.tenantId, msg.branchId));
      for (const st of msg.stations ?? []) {
        const perm = st === 'bar' ? P.BAR_VIEW : st === 'kitchen' ? P.KITCHEN_VIEW : null;
        if (perm && ctx.permissions.has(perm)) socket.join(stationRoom(ctx.tenantId, msg.branchId, st));
      }
      ack?.({ ok: true });
    });
  });
  setIo(io);
  logger.info('Realtime server attached');
  return io;
}
