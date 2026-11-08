import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BedDouble, CalendarCheck, LogIn, LogOut, Plus, UserRound } from 'lucide-react';
import { get, patch, post } from '@/lib/api';
import { fromCents, money, toCents } from '@/lib/format';
import { Button, Card, DataTable, Empty, Field, Input, Modal, PageHeader, Pill, Select, StatusPill, Tabs, Textarea, Toggle } from '@/components/ui';
import { useAuth } from '@/auth/AuthContext';
import { useFeedback } from '@/components/feedback';
import { onSocket } from '@/lib/socket';

type Room = { _id: string; number: string; roomType: string; capacity: number; nightlyRate: number; active: boolean };
type RoomForm = { _id?: string; number?: string; roomType?: string; capacity?: number; nightlyRate?: string; active?: boolean };
type Stay = { _id: string; roomId: string; guestName: string; phone?: string; email?: string; guestCount: number; checkIn: string; checkOut: string; nightlyRate: number; total: number; status: 'reserved' | 'checked_in' | 'checked_out' | 'cancelled'; notes?: string };
type TabId = 'stays' | 'rooms';

const localDate = (date: Date) => {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 10);
};
const displayDate = (date: string) => new Date(date).toLocaleDateString('en-KE', { dateStyle: 'medium' });

export default function AccommodationPage() {
  const { can, branch } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>('stays');
  const [roomForm, setRoomForm] = useState<RoomForm | null>(null);
  const [bookingForm, setBookingForm] = useState<any>(null);
  const [selectedStay, setSelectedStay] = useState<Stay | null>(null);
  const rooms = useQuery<Room[]>({ queryKey: ['accommodation-rooms', branch?.id], queryFn: () => get('/accommodation/rooms') });
  const stays = useQuery<Stay[]>({ queryKey: ['accommodation-stays', branch?.id], queryFn: () => get('/accommodation/stays') });
  const canManage = can('accommodation.manage');
  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['accommodation-rooms'] });
    qc.invalidateQueries({ queryKey: ['accommodation-stays'] });
  }, [qc]);
  useEffect(() => onSocket('accommodation.updated', refresh), [refresh]);

  const saveRoom = async () => {
    if (!roomForm) return;
    const body = { number: roomForm.number, roomType: roomForm.roomType || 'Standard', capacity: Number(roomForm.capacity ?? 2), nightlyRate: toCents(roomForm.nightlyRate ?? '0'), active: roomForm.active ?? true };
    try {
      if (roomForm._id) await patch(`/accommodation/rooms/${roomForm._id}`, body);
      else await post('/accommodation/rooms', body);
      refresh();
      setRoomForm(null);
      toast('Room saved');
    } catch (e) { handleError(e); }
  };

  const saveBooking = async () => {
    if (!bookingForm) return;
    try {
      await post('/accommodation/stays', {
        roomId: bookingForm.roomId,
        guestName: bookingForm.guestName,
        phone: bookingForm.phone || undefined,
        email: bookingForm.email || undefined,
        guestCount: Number(bookingForm.guestCount),
        checkIn: new Date(`${bookingForm.checkIn}T00:00:00`).toISOString(),
        checkOut: new Date(`${bookingForm.checkOut}T00:00:00`).toISOString(),
        notes: bookingForm.notes || undefined,
      });
      refresh();
      setBookingForm(null);
      toast('Room booking created');
    } catch (e) { handleError(e); }
  };

  const changeStatus = async (stay: Stay, status: 'checked_in' | 'checked_out' | 'cancelled') => {
    try {
      const updated = await post<Stay>(`/accommodation/stays/${stay._id}/status`, { status });
      refresh();
      setSelectedStay(updated);
      toast(status === 'checked_in' ? 'Guest checked in' : status === 'checked_out' ? 'Guest checked out' : 'Booking cancelled');
    } catch (e) { handleError(e); }
  };

  const roomName = (id: string) => rooms.data?.find((room) => room._id === id)?.number ?? 'Room';
  const roomStatus = (room: Room) => {
    const now = Date.now();
    const current = (stays.data ?? []).find((stay) => stay.roomId === room._id && stay.status === 'checked_in');
    if (current) return 'occupied';
    const currentReservation = (stays.data ?? []).find((stay) => stay.roomId === room._id && stay.status === 'reserved' && new Date(stay.checkIn).getTime() <= now && new Date(stay.checkOut).getTime() > now);
    if (currentReservation) return 'reserved';
    return room.active ? 'available' : 'inactive';
  };
  const activeRooms = rooms.data?.filter((room) => room.active) ?? [];

  return (
    <div>
      <PageHeader title="Accommodation" subtitle="Manage rooms, guest bookings and check-in/check-out."
        actions={<>
          {canManage && tab === 'rooms' && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRoomForm({ roomType: 'Standard', capacity: 2, nightlyRate: '0', active: true })}>Add room</Button>}
          {canManage && tab === 'stays' && <Button icon={<Plus className="h-4 w-4" />} disabled={!activeRooms.length} onClick={() => {
            const today = new Date(); const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
            setBookingForm({ roomId: activeRooms[0]?._id ?? '', guestName: '', phone: '', email: '', guestCount: 1, checkIn: localDate(today), checkOut: localDate(tomorrow), notes: '' });
          }}>New booking</Button>}
        </>}
      />
      <Tabs<TabId> tabs={[{ id: 'stays', label: `Bookings (${stays.data?.length ?? 0})` }, { id: 'rooms', label: `Rooms (${rooms.data?.length ?? 0})` }]} value={tab} onChange={setTab} />

      {tab === 'stays' ? (
        <Card padded={false}>
          <DataTable rows={stays.data} loading={stays.isLoading} rowKey={(stay) => stay._id} onRowClick={setSelectedStay} empty={<Empty title="No room bookings yet" hint={canManage ? 'Add rooms, then create a guest booking.' : 'Room bookings will appear here.'} icon={<CalendarCheck className="h-6 w-6" />} />} columns={[
            { key: 'guest', header: 'Guest', render: (stay) => <div><p className="font-semibold">{stay.guestName}</p><p className="text-xs text-ink-soft">{stay.phone ?? stay.email ?? 'Guest'}</p></div> },
            { key: 'room', header: 'Room', render: (stay) => <b>{roomName(stay.roomId)}</b> },
            { key: 'dates', header: 'Stay', render: (stay) => <div><p>{displayDate(stay.checkIn)} – {displayDate(stay.checkOut)}</p><p className="text-xs text-ink-soft">{stay.guestCount} guest{stay.guestCount === 1 ? '' : 's'}</p></div> },
            { key: 'total', header: 'Room total', render: (stay) => money(stay.total) },
            { key: 'status', header: 'Status', render: (stay) => <StatusPill status={stay.status} /> },
          ]} />
        </Card>
      ) : (
        <Card padded={false}>
          <DataTable rows={rooms.data} loading={rooms.isLoading} rowKey={(room) => room._id} onRowClick={canManage ? (room) => setRoomForm({ ...room, nightlyRate: String(fromCents(room.nightlyRate)) }) : undefined} empty={<Empty title="No rooms set up" hint={canManage ? 'Add your first room to start accepting bookings.' : 'Ask a manager to add rooms.'} icon={<BedDouble className="h-6 w-6" />} />} columns={[
            { key: 'number', header: 'Room', render: (room) => <div><p className="font-semibold">{room.number}</p><p className="text-xs text-ink-soft">{room.roomType}</p></div> },
            { key: 'capacity', header: 'Guests', render: (room) => <span className="inline-flex items-center gap-1"><UserRound className="h-3.5 w-3.5" />{room.capacity}</span> },
            { key: 'rate', header: 'Nightly rate', render: (room) => money(room.nightlyRate) },
            { key: 'status', header: 'Status', render: (room) => <Pill color={roomStatus(room) === 'occupied' ? 'blue' : roomStatus(room) === 'reserved' ? 'yellow' : roomStatus(room) === 'available' ? 'green' : 'gray'}>{roomStatus(room)}</Pill> },
          ]} />
        </Card>
      )}

      {roomForm && <Modal open onClose={() => setRoomForm(null)} title={roomForm._id ? `Room ${roomForm.number}` : 'Add room'} footer={<Button onClick={saveRoom}>Save room</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Room number"><Input value={roomForm.number ?? ''} onChange={(e) => setRoomForm({ ...roomForm, number: e.target.value })} /></Field>
          <Field label="Room type"><Input value={roomForm.roomType ?? ''} onChange={(e) => setRoomForm({ ...roomForm, roomType: e.target.value })} placeholder="Standard, Deluxe…" /></Field>
          <Field label="Guest capacity"><Input type="number" min={1} max={20} value={roomForm.capacity ?? 2} onChange={(e) => setRoomForm({ ...roomForm, capacity: Number(e.target.value) })} /></Field>
          <Field label="Nightly rate (KSh)"><Input inputMode="decimal" value={roomForm.nightlyRate ?? '0'} onChange={(e) => setRoomForm({ ...roomForm, nightlyRate: e.target.value })} /></Field>
          {roomForm._id && <div className="sm:col-span-2"><Toggle checked={roomForm.active !== false} onChange={(v) => setRoomForm({ ...roomForm, active: v })} label="Available for new bookings" /></div>}
        </div>
      </Modal>}

      {bookingForm && <Modal open onClose={() => setBookingForm(null)} title="New room booking" footer={<Button onClick={saveBooking}>Book room</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Guest name" ><Input value={bookingForm.guestName} onChange={(e) => setBookingForm({ ...bookingForm, guestName: e.target.value })} /></Field>
          <Field label="Room"><Select value={bookingForm.roomId} onChange={(e) => setBookingForm({ ...bookingForm, roomId: e.target.value })}>{activeRooms.map((room) => <option key={room._id} value={room._id}>{room.number} · {room.roomType} · {money(room.nightlyRate)}/night</option>)}</Select></Field>
          <Field label="Phone"><Input inputMode="tel" value={bookingForm.phone} onChange={(e) => setBookingForm({ ...bookingForm, phone: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={bookingForm.email} onChange={(e) => setBookingForm({ ...bookingForm, email: e.target.value })} /></Field>
          <Field label="Guests"><Input type="number" min={1} value={bookingForm.guestCount} onChange={(e) => setBookingForm({ ...bookingForm, guestCount: Number(e.target.value) })} /></Field>
          <Field label="Check-in"><Input type="date" value={bookingForm.checkIn} onChange={(e) => setBookingForm({ ...bookingForm, checkIn: e.target.value })} /></Field>
          <Field label="Check-out"><Input type="date" value={bookingForm.checkOut} onChange={(e) => setBookingForm({ ...bookingForm, checkOut: e.target.value })} /></Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea value={bookingForm.notes} onChange={(e) => setBookingForm({ ...bookingForm, notes: e.target.value })} /></Field>
        </div>
      </Modal>}

      {selectedStay && <Modal open onClose={() => setSelectedStay(null)} title={selectedStay.guestName} footer={canManage && <>
        {selectedStay.status === 'reserved' && <><Button variant="ghost" onClick={() => changeStatus(selectedStay, 'cancelled')}>Cancel booking</Button><Button onClick={() => changeStatus(selectedStay, 'checked_in')}><LogIn className="mr-1 h-4 w-4" />Check in</Button></>}
        {selectedStay.status === 'checked_in' && <Button onClick={() => changeStatus(selectedStay, 'checked_out')}><LogOut className="mr-1 h-4 w-4" />Check out</Button>}
      </>}>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="label">Room</dt><dd>{roomName(selectedStay.roomId)}</dd></div>
          <div><dt className="label">Status</dt><dd><StatusPill status={selectedStay.status} /></dd></div>
          <div><dt className="label">Check-in</dt><dd>{displayDate(selectedStay.checkIn)}</dd></div>
          <div><dt className="label">Check-out</dt><dd>{displayDate(selectedStay.checkOut)}</dd></div>
          <div><dt className="label">Guests</dt><dd>{selectedStay.guestCount}</dd></div>
          <div><dt className="label">Phone / email</dt><dd>{selectedStay.phone ?? selectedStay.email ?? '—'}</dd></div>
          <div><dt className="label">Nightly rate</dt><dd>{money(selectedStay.nightlyRate)}</dd></div>
          <div><dt className="label">Room total</dt><dd className="font-semibold">{money(selectedStay.total)}</dd></div>
          {selectedStay.notes && <div className="col-span-2"><dt className="label">Notes</dt><dd>{selectedStay.notes}</dd></div>}
        </dl>
      </Modal>}
    </div>
  );
}
