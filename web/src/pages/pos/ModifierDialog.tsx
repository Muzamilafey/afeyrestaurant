import { useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button, Modal, Textarea, cx } from '@/components/ui';
import { money, uuid } from '@/lib/format';
import type { DraftLine, ModifierGroup, Product } from './types';

/** Choose size/variant, modifiers (respecting min/max), quantity and kitchen notes. */
export function ModifierDialog({ product, groups, station, onClose, onConfirm }: { product: Product; groups: ModifierGroup[]; station: string; onClose: () => void; onConfirm: (line: DraftLine) => void }) {
  const productGroups = groups.filter((g) => product.modifierGroupIds.includes(g._id));
  const [variant, setVariant] = useState<string | undefined>(product.variants[0]?.name);
  const [sel, setSel] = useState<Record<string, string[]>>(() => Object.fromEntries(productGroups.map((g) => [g._id, g.minSelect === 1 && g.maxSelect === 1 && g.options[0] ? [] : []])));
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [age, setAge] = useState(false);
  const base = variant ? product.variants.find((v) => v.name === variant)?.price ?? product.currentPrice : product.currentPrice;
  const chosen = productGroups.flatMap((g) => (sel[g._id] ?? []).map((oid) => ({ g, o: g.options.find((o) => o._id === oid)! })));
  const unit = base + chosen.reduce((s, c) => s + (c.o?.priceDelta ?? 0), 0);
  const invalid = useMemo(() => productGroups.find((g) => (sel[g._id]?.length ?? 0) < g.minSelect), [productGroups, sel]);

  const toggle = (g: ModifierGroup, oid: string) => {
    setSel((s) => {
      const cur = s[g._id] ?? [];
      if (cur.includes(oid)) return { ...s, [g._id]: cur.filter((x) => x !== oid) };
      if (g.maxSelect === 1) return { ...s, [g._id]: [oid] };
      if (cur.length >= g.maxSelect) return s;
      return { ...s, [g._id]: [...cur, oid] };
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={product.name}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex items-center gap-2 rounded-xl bg-page p-1">
            <button className="grid h-10 w-10 place-items-center rounded-lg bg-card" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Decrease"><Minus className="h-4 w-4" /></button>
            <span className="w-8 text-center font-bold">{qty}</span>
            <button className="grid h-10 w-10 place-items-center rounded-lg bg-card" onClick={() => setQty(qty + 1)} aria-label="Increase"><Plus className="h-4 w-4" /></button>
          </div>
          <Button size="lg" disabled={!!invalid || (product.ageRestricted && !age)} onClick={() => onConfirm({ lineId: uuid(), productId: product._id, name: variant ? `${product.name} (${variant})` : product.name, qty, unitPrice: unit, variant, station, notes: notes || undefined, ageCheckConfirmed: product.ageRestricted ? age : undefined, modifiers: chosen.map((c) => ({ groupId: c.g._id, optionId: c.o._id, name: c.o.name, priceDelta: c.o.priceDelta })) })}>
            Add · {money(unit * qty)}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {product.description && <p className="text-sm text-ink-soft">{product.description}</p>}
        {(product.allergens?.length ?? 0) > 0 && <p className="rounded-xl bg-warn-pale px-3 py-2 text-xs text-warn-ink">Allergens: {product.allergens!.join(', ')}</p>}
        {product.variants.length > 0 && (
          <div>
            <p className="label">Size</p>
            <div className="flex flex-wrap gap-2">
              {product.variants.map((v) => (
                <button key={v.name} onClick={() => setVariant(v.name)} className={cx('rounded-xl border-2 px-4 py-2.5 text-sm font-semibold', variant === v.name ? 'border-brand bg-brand-pale text-brand-dark' : 'border-line')}>
                  {v.name} · {money(v.price)}
                </button>
              ))}
            </div>
          </div>
        )}
        {productGroups.map((g) => (
          <div key={g._id}>
            <p className="label">
              {g.name} <span className="normal-case tracking-normal">({g.minSelect > 0 ? `required, ` : ''}choose {g.maxSelect === 1 ? 'one' : `up to ${g.maxSelect}`})</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {g.options.filter((o) => o.active !== false).map((o) => {
                const on = sel[g._id]?.includes(o._id);
                return (
                  <button key={o._id} onClick={() => toggle(g, o._id)} className={cx('rounded-xl border-2 px-4 py-2.5 text-sm font-semibold', on ? 'border-brand bg-brand-pale text-brand-dark' : 'border-line')}>
                    {o.name}{o.priceDelta ? ` +${money(o.priceDelta, false)}` : ''}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div>
          <p className="label">Cooking instructions / special requests</p>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder="e.g. no onions, sauce on the side" />
        </div>
        {product.ageRestricted && (
          <label className="flex items-start gap-3 rounded-xl border border-warn bg-warn-pale p-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-5 w-5 accent-brand" checked={age} onChange={(e) => setAge(e.target.checked)} />
            <span><b>Age-restricted product.</b> I have confirmed the customer is 18 years or older.</span>
          </label>
        )}
      </div>
    </Modal>
  );
}
