import { io, type Socket } from 'socket.io-client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAccessToken } from './api';

let socket: Socket | null = null;
let joined: string | null = null;

/** Single shared socket; re-joins rooms when the branch or stations change. */
export function useRealtime(branchId: string | null, stations: string[] = []) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!branchId || !getAccessToken()) return;
    if (!socket) socket = io({ path: '/api/v1/realtime', auth: (cb) => cb({ token: getAccessToken() }), transports: ['websocket', 'polling'] });
    const key = `${branchId}|${stations.join(',')}`;
    const join = () => socket!.emit('join', { branchId, stations });
    if (joined !== key) {
      joined = key;
      if (socket.connected) join();
    }
    socket.on('connect', join);
    const invalidate = (keys: string[][]) => () => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
    const onOrder = invalidate([['orders'], ['order'], ['tables']]);
    const onTicket = invalidate([['tickets']]);
    const onTable = invalidate([['tables']]);
    const onPayment = invalidate([['order'], ['orders'], ['attempt']]);
    const onReservation = invalidate([['reservations']]);
    socket.on('order.updated', onOrder);
    socket.on('ticket.created', onTicket);
    socket.on('ticket.updated', onTicket);
    socket.on('table.updated', onTable);
    socket.on('payment.updated', onPayment);
    socket.on('reservation.updated', onReservation);
    return () => {
      socket?.off('connect', join);
      socket?.off('order.updated', onOrder);
      socket?.off('ticket.created', onTicket);
      socket?.off('ticket.updated', onTicket);
      socket?.off('table.updated', onTable);
      socket?.off('payment.updated', onPayment);
      socket?.off('reservation.updated', onReservation);
    };
  }, [branchId, stations.join(','), qc]);
}

export function onSocket(event: string, fn: (payload: any) => void) {
  socket?.on(event, fn);
  return () => {
    socket?.off(event, fn);
  };
}
