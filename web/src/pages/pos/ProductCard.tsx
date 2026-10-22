import { Minus, Plus, Clock3, Leaf, Flame, AlertTriangle } from 'lucide-react';
import { cx } from '@/components/ui';
import { money } from '@/lib/format';
import type { Product } from './types';

const KIND_EMOJI: Record<string, string> = { food: '🍽️', soft_drink: '🥤', alcohol: '🍸', cocktail: '🍹', beer: '🍺', wine: '🍷', spirit: '🥃', other: '🍴' };
const GRADIENT: Record<string, string> = {
  food: 'from-[#FDE7D3] to-[#F8C9A0]', soft_drink: 'from-[#DDF1FB] to-[#B7E0F4]', cocktail: 'from-[#FCE1EE] to-[#F6B9D3]', beer: 'from-[#FFF1C9] to-[#F7D873]',
  wine: 'from-[#F3DDE3] to-[#D9A4B3]', spirit: 'from-[#EDE6DA] to-[#D6C4A4]', alcohol: 'from-[#E6F3E9] to-[#BFE3C8]', other: 'from-[#EEF0EF] to-[#D9DEDB]',
};

export function ProductImage({ product, kind, className }: { product: Product; kind: string; className?: string }) {
  if (product.imageUrl) return <img src={product.imageUrl} alt="" loading="lazy" className={cx('h-full w-full object-cover', className)} />;
  return (
    <div className={cx('grid h-full w-full place-items-center bg-gradient-to-br text-4xl', GRADIENT[kind] ?? GRADIENT.other, className)} aria-hidden>
      {KIND_EMOJI[kind] ?? '🍴'}
    </div>
  );
}

export function ProductCard({ product, kind, qtyInCart, onAdd, onDec }: { product: Product; kind: string; qtyInCart: number; onAdd: () => void; onDec: () => void }) {
  const selected = qtyInCart > 0;
  const disabled = !product.available;
  return (
    <div className={cx('group relative flex flex-col overflow-hidden rounded-2xl border-2 bg-card shadow-soft transition', selected ? 'border-brand' : 'border-transparent', disabled && 'opacity-60')}>
      <button type="button" disabled={disabled} onClick={onAdd} className="relative aspect-[4/3] w-full overflow-hidden" aria-label={`Add ${product.name}`}>
        <ProductImage product={product} kind={kind} className="transition group-hover:scale-[1.03]" />
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          {product.happyHour && <span className="pill bg-warn text-ink"><Clock3 className="h-3 w-3" /> Happy hour</span>}
          {product.lowStock && <span className="pill bg-white/95 text-warn-ink"><AlertTriangle className="h-3 w-3" /> {product.servingsLeft} left</span>}
          {product.ageRestricted && <span className="pill bg-ink/80 text-white">18+</span>}
        </div>
        {disabled && (
          <div className="absolute inset-0 grid place-items-center bg-white/60">
            <span className="pill bg-danger text-white">{product.unavailableReason === 'out_of_stock' ? 'Out of stock' : product.unavailableReason === 'not_scheduled' ? 'Not available now' : 'Sold out'}</span>
          </div>
        )}
      </button>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="line-clamp-2 text-sm font-semibold leading-snug">{product.name}</p>
        <div className="flex flex-wrap gap-1">
          {product.dietary.includes('vegetarian') || product.dietary.includes('vegan') ? <span className="pill bg-brand-pale px-1.5 text-[10px] text-brand-dark"><Leaf className="h-3 w-3" />{product.dietary.includes('vegan') ? 'Vegan' : 'Veg'}</span> : null}
          {product.dietary.includes('spicy') && <span className="pill bg-danger-pale px-1.5 text-[10px] text-danger"><Flame className="h-3 w-3" />Spicy</span>}
          {product.dietary.includes('halal') && <span className="pill bg-page px-1.5 text-[10px] text-ink-soft">Halal</span>}
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <div>
            <p className="text-sm font-bold text-brand-dark">{money(product.currentPrice)}</p>
            {product.currentPrice !== product.price && <p className="text-[11px] text-ink-soft line-through">{money(product.price)}</p>}
          </div>
          {selected ? (
            <div className="flex items-center gap-1 rounded-xl bg-brand-pale p-1">
              <button className="grid h-8 w-8 place-items-center rounded-lg bg-card text-brand-dark" onClick={onDec} aria-label="Decrease"><Minus className="h-4 w-4" /></button>
              <span className="w-6 text-center text-sm font-bold">{qtyInCart}</span>
              <button className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white" onClick={onAdd} disabled={disabled} aria-label="Increase"><Plus className="h-4 w-4" /></button>
            </div>
          ) : (
            <button className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-white disabled:opacity-40" onClick={onAdd} disabled={disabled} aria-label="Add to order">
              <Plus className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
