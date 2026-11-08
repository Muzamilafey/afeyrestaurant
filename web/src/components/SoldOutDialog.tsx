import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, RotateCcw, Search } from 'lucide-react';
import { get, post } from '@/lib/api';
import { Button, Input, Modal, Pill, Select, cx } from '@/components/ui';
import { useFeedback } from '@/components/feedback';

interface CatProduct { _id: string; name: string; categoryId: string; status: string; soldOutUntil?: string | null; soldOutBy?: string | null }
interface Cat { _id: string; name: string; station: string }

/**
 * Sold out ("86") in one tap: find the item, mark it sold out (until the end of the day by default) or put it back
 * on sale. Every till and the kitchen/bar screens update at once. `station` limits the list to that station's items.
 */
export function SoldOutDialog({ onClose, station }: { onClose: () => void; station?: 'kitchen' | 'bar' }) {
  const { toast, handleError } = useFeedback();
  const qc = useQueryClient();
  const { data } = useQuery<{ categories: Cat[]; products: CatProduct[] }>({ queryKey: ['catalog', 'sold-out'], queryFn: () => get('/menu/catalog') });
  const [q, setQ] = useState('');
  const [until, setUntil] = useState<'end_of_day' | 'manual'>('end_of_day');
  const [busy, setBusy] = useState<string | null>(null);
  const cats = useMemo(() => new Map(data?.categories.map((c) => [c._id, c]) ?? []), [data]);
  const rows = (data?.products ?? [])
    .filter((p) => !station || (cats.get(p.categoryId)?.station ?? 'kitchen') === station)
    .filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(b.status === 'sold_out') - Number(a.status === 'sold_out') || a.name.localeCompare(b.name));
  const soldOut = rows.filter((p) => p.status === 'sold_out').length;

  async function toggle(p: CatProduct) {
    const out = p.status !== 'sold_out';
    setBusy(p._id);
    try {
      await post(`/menu/products/${p._id}/sold-out`, { soldOut: out, until });
      qc.invalidateQueries({ queryKey: ['catalog'] });
      toast(out ? `${p.name} is sold out${until === 'end_of_day' ? ' for today' : ''}` : `${p.name} is back on sale`);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Sold out items${soldOut ? ` · ${soldOut}` : ''}`} size="lg">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[200px] flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an item…" className="pl-9" /></div>
          <Select value={until} onChange={(e) => setUntil(e.target.value as typeof until)} className="w-48" aria-label="Sold out until"><option value="end_of_day">Until end of today</option><option value="manual">Until switched back</option></Select>
        </div>
        <div className="max-h-[55vh] divide-y divide-line overflow-y-auto">
          {rows.map((p) => {
            const out = p.status === 'sold_out';
            return (
              <div key={p._id} className={cx('flex items-center gap-3 py-2', out && 'opacity-90')}>
                <div className="min-w-0 flex-1">
                  <p className={cx('truncate font-semibold', out && 'text-danger line-through')}>{p.name}</p>
                  <p className="truncate text-xs text-ink-soft">{cats.get(p.categoryId)?.name}{out && p.soldOutBy ? ` · by ${p.soldOutBy}` : ''}{out && p.soldOutUntil ? ' · back tomorrow' : ''}</p>
                </div>
                {out && <Pill color="red">Sold out</Pill>}
                <Button size="sm" variant={out ? 'secondary' : 'danger'} loading={busy === p._id} icon={out ? <RotateCcw className="h-4 w-4" /> : <Ban className="h-4 w-4" />} onClick={() => toggle(p)}>{out ? 'Back on sale' : 'Sold out'}</Button>
              </div>
            );
          })}
          {!rows.length && <p className="py-6 text-center text-sm text-ink-soft">No items</p>}
        </div>
      </div>
    </Modal>
  );
}
