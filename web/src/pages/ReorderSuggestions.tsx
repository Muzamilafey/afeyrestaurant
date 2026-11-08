import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShoppingCart } from 'lucide-react';
import { get, post } from '@/lib/api';
import { money } from '@/lib/format';
import { Button, Card, Input, Pill, Select, Skeleton, cx } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface Line {
  ingredientId: string; name: string; unit: string; onHand: number; onOrder: number; dailyUsage: number; daysLeft: number | null; minLevel: number; target: number;
  suggestQty: number; purchaseUnit: { name: string; factor: number; qty: number } | null; supplierId: string | null; supplierName: string | null; estimatedCost: number; reason: string;
}
interface Resp { items: Line[]; estimatedTotal: number }

const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-KE');

/** What to buy, grouped by supplier, turned into draft purchase orders in one click per supplier. */
export function ReorderSuggestions({ suppliers }: { suppliers: Array<{ _id: string; name: string }> }) {
  const { can } = useAuth();
  const { toast, handleError } = useFeedback();
  const qc = useQueryClient();
  const [opts, setOpts] = useState({ days: 14, coverDays: 7, leadDays: 2 });
  const { data, isLoading } = useQuery<Resp>({ queryKey: ['reorder', opts], queryFn: () => get('/inventory/reorder-suggestions', opts) });
  // Per line: chosen?, quantity (in the purchase unit when there is one), supplier override.
  const [pick, setPick] = useState<Record<string, { on: boolean; qty?: string }>>({});
  const [groupSupplier, setGroupSupplier] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; supplierId: string | null; name: string; items: Line[] }>();
    for (const l of data?.items ?? []) {
      const key = l.supplierId ?? 'none';
      if (!m.has(key)) m.set(key, { key, supplierId: l.supplierId, name: l.supplierName ?? 'No preferred supplier', items: [] });
      m.get(key)!.items.push(l);
    }
    return [...m.values()];
  }, [data]);

  async function createPo(g: (typeof groups)[number]) {
    const supplierId = g.supplierId ?? groupSupplier[g.key];
    if (!supplierId) return toast('Choose the supplier for these items first', 'error');
    const lines = g.items.filter((l) => pick[l.ingredientId]?.on !== false).map((l) => {
      const q = Number(pick[l.ingredientId]?.qty ?? (l.purchaseUnit ? l.purchaseUnit.qty : l.suggestQty));
      return { ingredientId: l.ingredientId, qty: q, unit: l.purchaseUnit?.name };
    }).filter((l) => l.qty > 0);
    if (!lines.length) return toast('Nothing selected', 'error');
    setBusy(g.key);
    try {
      const po = await post<{ number: string }>('/inventory/reorder-suggestions/purchase-order', { supplierId, lines });
      qc.invalidateQueries({ queryKey: ['pos'] });
      qc.invalidateQueries({ queryKey: ['reorder'] });
      toast(`Draft ${po.number} created — review and submit it under Purchase orders`);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex items-center gap-2">Usage of the last <Input inputMode="numeric" className="w-16" value={opts.days} onChange={(e) => setOpts({ ...opts, days: Math.max(3, Number(e.target.value) || 14) })} /> days</label>
        <label className="flex items-center gap-2">Buy for <Input inputMode="numeric" className="w-16" value={opts.coverDays} onChange={(e) => setOpts({ ...opts, coverDays: Math.max(1, Number(e.target.value) || 7) })} /> days</label>
        <label className="flex items-center gap-2">Delivery takes <Input inputMode="numeric" className="w-16" value={opts.leadDays} onChange={(e) => setOpts({ ...opts, leadDays: Math.max(0, Number(e.target.value) || 0) })} /> days</label>
        <span className="ml-auto text-ink-soft">Estimated total <b className="text-ink">{money(data?.estimatedTotal ?? 0)}</b></span>
      </div>
      {isLoading ? <Skeleton className="h-40" /> : !groups.length ? (
        <Card><p className="py-6 text-center text-sm text-ink-soft">Nothing to reorder — stock covers the next days. Set minimum levels on ingredients for earlier warnings.</p></Card>
      ) : groups.map((g) => (
        <Card key={g.key} title={g.name} actions={can('procurement.manage') && (
          <div className="flex items-center gap-2">
            {!g.supplierId && <Select value={groupSupplier[g.key] ?? ''} onChange={(e) => setGroupSupplier({ ...groupSupplier, [g.key]: e.target.value })} className="w-48" aria-label="Supplier"><option value="">Choose supplier…</option>{suppliers.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}</Select>}
            <Button size="sm" icon={<ShoppingCart className="h-4 w-4" />} loading={busy === g.key} onClick={() => createPo(g)}>Create draft PO</Button>
          </div>
        )}>
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead><tr className="text-left text-xs uppercase text-ink-soft"><th className="py-2 pr-2" /><th>Item</th><th>On hand</th><th>On order</th><th>Use / day</th><th>Left</th><th>Buy</th><th className="text-right">Est. cost</th></tr></thead>
              <tbody className="divide-y divide-line">
                {g.items.map((l) => {
                  const p = pick[l.ingredientId] ?? { on: true };
                  return (
                    <tr key={l.ingredientId} className={cx(p.on === false && 'opacity-50')}>
                      <td className="py-2 pr-2"><input type="checkbox" className="h-4 w-4 accent-brand" checked={p.on !== false} onChange={(e) => setPick({ ...pick, [l.ingredientId]: { ...p, on: e.target.checked } })} aria-label={`Include ${l.name}`} /></td>
                      <td><p className="font-semibold">{l.name}</p><p className="text-xs text-ink-soft">{l.reason}</p></td>
                      <td className="tabular-nums">{fmt(l.onHand)} {l.unit}</td>
                      <td className="tabular-nums">{l.onOrder ? `${fmt(l.onOrder)} ${l.unit}` : '—'}</td>
                      <td className="tabular-nums">{fmt(l.dailyUsage)} {l.unit}</td>
                      <td>{l.daysLeft === null ? '—' : <Pill color={l.daysLeft <= 1 ? 'red' : l.daysLeft <= 3 ? 'yellow' : 'gray'}>{fmt(l.daysLeft)} d</Pill>}</td>
                      <td>
                        <div className="flex items-center gap-1">
                          <Input inputMode="decimal" className="w-20" value={p.qty ?? String(l.purchaseUnit ? l.purchaseUnit.qty : l.suggestQty)} onChange={(e) => setPick({ ...pick, [l.ingredientId]: { ...p, qty: e.target.value.replace(/[^\d.]/g, '') } })} aria-label={`Quantity of ${l.name}`} />
                          <span className="text-xs text-ink-soft">{l.purchaseUnit ? `${l.purchaseUnit.name} (${fmt(l.purchaseUnit.factor)} ${l.unit})` : l.unit}</span>
                        </div>
                      </td>
                      <td className="text-right tabular-nums">{money(l.estimatedCost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}
