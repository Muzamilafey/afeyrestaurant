import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bike, Check, MapPin, Phone, UserRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, Field, Input, Modal, cx } from '@/components/ui';
import { get } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';

export interface Rider { _id: string; name: string; phone?: string; vehicle?: string; plate?: string; active: boolean; activeDeliveries?: number }
export interface DeliveryDetails { riderId?: string; address: string; customerName: string; customerPhone: string }

/**
 * Shown when a delivery order is placed: where it goes, who it is for, and which rider takes it. The rider can also
 * be left for later (assigned from the Delivery page).
 */
export function AssignRiderDialog({ initial, action, onClose, onConfirm }: { initial: DeliveryDetails; action: 'send' | 'pay'; onClose: () => void; onConfirm: (d: DeliveryDetails) => void }) {
  const { can } = useAuth();
  const { data: riders, isLoading } = useQuery<Rider[]>({ queryKey: ['riders'], queryFn: () => get('/crm/riders') });
  const [d, setD] = useState<DeliveryDetails>(initial);
  const active = (riders ?? []).filter((r) => r.active);
  const ok = d.address.trim().length >= 3;
  const go = action === 'pay' ? 'place and take payment' : 'place the order';

  return (
    <Modal
      open
      onClose={onClose}
      title="Delivery: assign a rider"
      size="lg"
      footer={
        <>
          <Button variant="secondary" disabled={!ok} onClick={() => onConfirm({ ...d, riderId: undefined })}>Assign later</Button>
          <Button disabled={!ok || !d.riderId} icon={<Bike className="h-4 w-4" />} onClick={() => onConfirm(d)}>
            Assign {d.riderId ? active.find((r) => r._id === d.riderId)?.name.split(' ')[0] : 'rider'} &amp; {action === 'pay' ? 'pay' : 'place order'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Delivery address" className="sm:col-span-2" error={!ok && d.address ? 'Enter the address' : undefined}>
            <div className="relative"><MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><Input autoFocus={!initial.address} className="pl-9" value={d.address} onChange={(e) => setD({ ...d, address: e.target.value })} placeholder="Estate, street, house / landmark" /></div>
          </Field>
          <Field label="Customer name"><div className="relative"><UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><Input className="pl-9" value={d.customerName} onChange={(e) => setD({ ...d, customerName: e.target.value })} /></div></Field>
          <Field label="Customer phone"><div className="relative"><Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><Input className="pl-9" inputMode="tel" value={d.customerPhone} onChange={(e) => setD({ ...d, customerPhone: e.target.value })} placeholder="07XX XXX XXX" /></div></Field>
        </div>

        <div>
          <p className="label mb-2">Delivery rider</p>
          {isLoading ? (
            <p className="text-sm text-ink-soft">Loading riders…</p>
          ) : active.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line p-4 text-sm text-ink-soft">
              No delivery riders registered yet.{' '}
              {can('delivery.manage') ? <Link to="/delivery?tab=riders" className="font-semibold text-brand-dark underline" onClick={onClose}>Register riders</Link> : 'Ask a manager to register riders in Delivery → Riders.'}{' '}
              You can still {go} and assign a rider later.
            </div>
          ) : (
            <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
              {active.map((r) => {
                const sel = d.riderId === r._id;
                return (
                  <button key={r._id} type="button" aria-pressed={sel} onClick={() => setD({ ...d, riderId: sel ? undefined : r._id })} className={cx('flex items-center gap-3 rounded-xl border-2 p-3 text-left transition', sel ? 'border-brand bg-brand-pale' : 'border-line hover:border-brand/50')}>
                    <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', sel ? 'bg-brand text-white' : 'bg-page text-ink-soft')}>{sel ? <Check className="h-5 w-5" /> : <Bike className="h-5 w-5" />}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{r.name}</span>
                      <span className="block truncate text-xs text-ink-soft">{[r.vehicle, r.plate, r.phone].filter(Boolean).join(' · ') || 'Rider'}</span>
                      <span className={cx('text-xs font-semibold', r.activeDeliveries ? 'text-warn-ink' : 'text-brand-dark')}>{r.activeDeliveries ? `${r.activeDeliveries} on the way` : 'Available'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
