import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Bell, CheckCircle2, ChefHat, Loader2, Minus, Plus, Receipt, ShoppingBag, Smartphone, X } from 'lucide-react';
import { money, uuid } from '@/lib/format';

interface Product { id: string; name: string; description?: string; imageUrl?: string; categoryId: string; price: number; happyHour: boolean; variants: Array<{ name: string; price: number }>; modifierGroupIds: string[]; dietary: string[] }
interface Group { id: string; name: string; minSelect: number; maxSelect: number; options: Array<{ id: string; name: string; priceDelta: number }> }
interface Menu { restaurant: string; branding: { logoUrl: string | null; color: string }; branch: string; table: { number: string; area: string | null }; canPay: boolean; requireAccept: boolean; categories: Array<{ id: string; name: string }>; products: Product[]; modifierGroups: Group[] }
interface CartLine { key: string; productId: string; name: string; qty: number; unit: number; variant?: string; modifiers: Array<{ groupId: string; optionId: string; name: string }>; notes?: string }
interface GuestOrder { id: string; number: string; status: string; waitingForStaff: boolean; items: Array<{ name: string; qty: number; total: number; status: string }>; total: number; paid: number; balance: number }

const STATUS: Record<string, string> = { waiting: 'Waiting for a waiter', new: 'Received', pending: 'Sent to the kitchen', accepted: 'Accepted', preparing: 'Being prepared', ready: 'Ready', served: 'Served', cancelled: 'Cancelled' };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1/qr${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'chili-pos', ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message ?? 'Something went wrong — please ask a waiter');
  return j.data as T;
}

/** What a guest sees after scanning the QR code on their table. */
export default function GuestTable() {
  const { token = '' } = useParams();
  const storeKey = `chili.qr.${token}`;
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState('');
  const [cat, setCat] = useState('all');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [pick, setPick] = useState<Product | null>(null);
  const [showCart, setShowCart] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [orderId, setOrderId] = useState<string | null>(() => { try { return localStorage.getItem(storeKey); } catch { return null; } });
  const [order, setOrder] = useState<GuestOrder | null>(null);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    call<Menu>(`/t/${token}`).then((m) => { setMenu(m); document.title = `${m.restaurant} · Table ${m.table.number}`; }).catch((e) => setError(e.message));
  }, [token]);
  // Follow the order: received → preparing → ready → served, and the bill.
  useEffect(() => {
    if (!orderId) return;
    let stop = false;
    const tick = () => call<GuestOrder>(`/t/${token}/orders/${orderId}`).then((o) => { if (!stop) setOrder(o); }).catch(() => { localStorage.removeItem(storeKey); setOrderId(null); setOrder(null); });
    tick();
    const t = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [orderId, token]);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3500); };

  const color = menu?.branding.color ?? '#07963C';
  const products = useMemo(() => (menu?.products ?? []).filter((p) => cat === 'all' || p.categoryId === cat), [menu, cat]);
  const cartTotal = cart.reduce((s, l) => s + l.unit * l.qty, 0);
  const cartCount = cart.reduce((s, l) => s + l.qty, 0);

  function add(p: Product) {
    if (p.variants.length || p.modifierGroupIds.length) return setPick(p);
    setCart((c) => {
      const same = c.find((l) => l.productId === p.id && !l.variant && !l.modifiers.length);
      return same ? c.map((l) => (l === same ? { ...l, qty: l.qty + 1 } : l)) : [...c, { key: uuid(), productId: p.id, name: p.name, qty: 1, unit: p.price, modifiers: [] }];
    });
  }
  async function place() {
    setBusy(true);
    try {
      const o = await call<GuestOrder>(`/t/${token}/orders`, { method: 'POST', body: JSON.stringify({ clientId: uuid(), name: name || undefined, orderId: order && ['open', 'held'].includes(order.status) ? order.id : undefined, items: cart.map((l) => ({ productId: l.productId, qty: l.qty, variant: l.variant, modifiers: l.modifiers.map(({ groupId, optionId }) => ({ groupId, optionId })), notes: l.notes })) }) });
      try { localStorage.setItem(storeKey, o.id); } catch { /* private mode */ }
      setOrderId(o.id);
      setOrder(o);
      setCart([]);
      setShowCart(false);
      window.scrollTo({ top: 0, behavior: 'smooth' }); // the order status card is at the top
      flash(o.waitingForStaff ? 'Order sent — a waiter will confirm it shortly' : 'Order sent to the kitchen');
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function callStaff(reason: 'waiter' | 'bill') {
    try {
      await call(`/t/${token}/call`, { method: 'POST', body: JSON.stringify({ reason }) });
      flash(reason === 'bill' ? 'A waiter will bring your bill' : 'A waiter is on the way');
    } catch (e) {
      flash((e as Error).message);
    }
  }

  if (error) return <div className="grid min-h-screen place-items-center bg-page p-6 text-center"><div><p className="text-xl font-bold">Sorry</p><p className="mt-2 text-ink-soft">{error}</p></div></div>;
  if (!menu) return <div className="grid min-h-screen place-items-center bg-page"><Loader2 className="h-8 w-8 animate-spin text-ink-soft" /></div>;

  return (
    <div className="min-h-screen bg-page pb-28 text-ink">
      <header className="sticky top-0 z-10 text-white shadow" style={{ background: color }}>
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          {menu.branding.logoUrl && <img src={menu.branding.logoUrl} alt="" className="h-10 w-10 rounded-xl bg-white object-contain p-0.5" />}
          <div className="min-w-0 flex-1"><p className="truncate text-lg font-bold">{menu.restaurant}</p><p className="text-sm opacity-90">Table {menu.table.number}{menu.table.area ? ` · ${menu.table.area}` : ''}</p></div>
          <button onClick={() => callStaff('waiter')} className="flex items-center gap-1 rounded-full bg-white/20 px-3 py-1.5 text-sm font-semibold"><Bell className="h-4 w-4" /> Waiter</button>
        </div>
        <div className="mx-auto flex max-w-2xl gap-2 overflow-x-auto px-4 pb-3">
          {[{ id: 'all', name: 'All' }, ...menu.categories].map((c) => (
            <button key={c.id} onClick={() => setCat(c.id)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold ${cat === c.id ? 'bg-white text-ink' : 'bg-white/20'}`}>{c.name}</button>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        {order && (
          <section className="rounded-2xl bg-card p-4 shadow-soft">
            <div className="flex items-center justify-between"><p className="font-bold">Your order {order.number}</p>{order.waitingForStaff ? <span className="rounded-full bg-warn-pale px-2 py-0.5 text-xs font-semibold text-warn-ink">Waiting for a waiter</span> : <ChefHat className="h-5 w-5 text-ink-soft" />}</div>
            <ul className="mt-2 divide-y divide-line text-sm">
              {order.items.map((i, n) => <li key={n} className="flex justify-between gap-2 py-1.5"><span>{i.qty} × {i.name}</span><span className="text-ink-soft">{STATUS[i.status] ?? i.status}</span></li>)}
            </ul>
            <div className="mt-2 flex justify-between font-semibold"><span>{order.status === 'paid' ? 'Paid' : 'To pay'}</span><span>{money(order.status === 'paid' ? order.total : order.balance)}</span></div>
            {order.status === 'paid' ? (
              <p className="mt-3 flex items-center gap-2 rounded-xl bg-brand-pale p-3 text-sm font-semibold text-brand-dark"><CheckCircle2 className="h-5 w-5" /> Paid — asante! Thank you.</p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {menu.canPay && !order.waitingForStaff && order.balance >= 100 && <button onClick={() => setPaying(true)} className="flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 font-semibold text-white" style={{ background: color }}><Smartphone className="h-4 w-4" /> Pay with M-Pesa</button>}
                <button onClick={() => callStaff('bill')} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-line px-3 py-2.5 font-semibold"><Receipt className="h-4 w-4" /> Ask for the bill</button>
              </div>
            )}
          </section>
        )}
        <div className="grid gap-3">
          {products.map((p) => {
            const inCart = cart.filter((l) => l.productId === p.id).reduce((s, l) => s + l.qty, 0);
            return (
              <div key={p.id} className="flex gap-3 rounded-2xl bg-card p-3 shadow-soft">
                {p.imageUrl ? <img src={p.imageUrl} alt="" className="h-24 w-24 shrink-0 rounded-xl object-cover" /> : <div className="grid h-24 w-24 shrink-0 place-items-center rounded-xl bg-page text-3xl">🍽️</div>}
                <div className="flex min-w-0 flex-1 flex-col">
                  <p className="font-semibold leading-tight">{p.name}</p>
                  {p.description && <p className="line-clamp-2 text-xs text-ink-soft">{p.description}</p>}
                  <div className="mt-auto flex items-center justify-between pt-2">
                    <span className="font-bold" style={{ color }}>{money(p.price)}{p.happyHour && <span className="ml-1 rounded bg-warn-pale px-1 text-[10px] text-warn-ink">happy hour</span>}</span>
                    <button onClick={() => add(p)} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-semibold text-white" style={{ background: color }}><Plus className="h-4 w-4" /> {inCart ? inCart : 'Add'}</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {cartCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 p-4">
          <button onClick={() => setShowCart(true)} className="mx-auto flex w-full max-w-2xl items-center justify-between rounded-2xl px-5 py-4 font-bold text-white shadow-lift" style={{ background: color }}>
            <span className="flex items-center gap-2"><ShoppingBag className="h-5 w-5" /> {cartCount} item{cartCount > 1 ? 's' : ''}</span><span>Review order · {money(cartTotal)}</span>
          </button>
        </div>
      )}

      {pick && <PickOptions product={pick} groups={menu.modifierGroups} color={color} onClose={() => setPick(null)} onAdd={(l) => { setCart((c) => [...c, l]); setPick(null); }} />}

      {showCart && (
        <Sheet onClose={() => setShowCart(false)} title={order && ['open', 'held'].includes(order.status) ? 'Add to your order' : 'Your order'}>
          <ul className="divide-y divide-line">
            {cart.map((l) => (
              <li key={l.key} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1"><p className="font-semibold">{l.name}{l.variant ? ` (${l.variant})` : ''}</p>{l.modifiers.length > 0 && <p className="text-xs text-ink-soft">{l.modifiers.map((m) => m.name).join(', ')}</p>}</div>
                <div className="flex items-center gap-1 rounded-xl bg-page p-1">
                  <button aria-label="Less" onClick={() => setCart((c) => c.flatMap((x) => (x.key !== l.key ? [x] : x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : [])))} className="grid h-8 w-8 place-items-center rounded-lg bg-card"><Minus className="h-4 w-4" /></button>
                  <span className="w-6 text-center font-bold">{l.qty}</span>
                  <button aria-label="More" onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, qty: Math.min(20, x.qty + 1) } : x)))} className="grid h-8 w-8 place-items-center rounded-lg bg-card"><Plus className="h-4 w-4" /></button>
                </div>
                <span className="w-24 text-right font-semibold">{money(l.unit * l.qty)}</span>
              </li>
            ))}
          </ul>
          {!order && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)" className="mt-3 w-full rounded-xl border border-line bg-page px-3 py-2.5" />}
          <p className="mt-3 text-xs text-ink-soft">{menu.requireAccept ? 'A waiter confirms your order before it goes to the kitchen.' : 'Your order goes straight to the kitchen.'} Prices include tax.</p>
          <button disabled={busy} onClick={place} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-4 text-lg font-bold text-white disabled:opacity-60" style={{ background: color }}>{busy && <Loader2 className="h-5 w-5 animate-spin" />} Send order · {money(cartTotal)}</button>
        </Sheet>
      )}

      {paying && order && <PayMpesa token={token} order={order} color={color} onClose={() => setPaying(false)} onPaid={() => { setPaying(false); flash('Payment received — thank you!'); call<GuestOrder>(`/t/${token}/orders/${order.id}`).then(setOrder).catch(() => undefined); }} />}

      {toast && <div className="fixed inset-x-4 top-24 z-30 mx-auto max-w-md rounded-2xl bg-ink px-4 py-3 text-center text-sm font-semibold text-card shadow-lift">{toast}</div>}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 flex items-end bg-black/40" onClick={onClose}>
      <div className="mx-auto max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between"><p className="text-lg font-bold">{title}</p><button onClick={onClose} aria-label="Close" className="rounded-full p-2 hover:bg-page"><X className="h-5 w-5" /></button></div>
        {children}
      </div>
    </div>
  );
}

function PickOptions({ product, groups, color, onClose, onAdd }: { product: Product; groups: Group[]; color: string; onClose: () => void; onAdd: (l: CartLine) => void }) {
  const [variant, setVariant] = useState(product.variants[0]?.name);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const mine = groups.filter((g) => product.modifierGroupIds.includes(g.id));
  const base = product.variants.find((v) => v.name === variant)?.price ?? product.price;
  const extra = mine.reduce((s, g) => s + (chosen[g.id] ?? []).reduce((a, id) => a + (g.options.find((o) => o.id === id)?.priceDelta ?? 0), 0), 0);
  const ok = mine.every((g) => (chosen[g.id]?.length ?? 0) >= g.minSelect);
  const toggle = (g: Group, id: string) => setChosen((c) => {
    const cur = c[g.id] ?? [];
    if (cur.includes(id)) return { ...c, [g.id]: cur.filter((x) => x !== id) };
    return { ...c, [g.id]: g.maxSelect === 1 ? [id] : cur.length < g.maxSelect ? [...cur, id] : cur };
  });
  return (
    <Sheet title={product.name} onClose={onClose}>
      {product.variants.length > 0 && (
        <div className="mb-4"><p className="mb-2 text-sm font-semibold">Size</p><div className="flex flex-wrap gap-2">{product.variants.map((v) => <button key={v.name} onClick={() => setVariant(v.name)} className={`rounded-xl border-2 px-3 py-2 text-sm font-semibold ${variant === v.name ? 'text-white' : 'border-line'}`} style={variant === v.name ? { background: color, borderColor: color } : undefined}>{v.name} · {money(v.price)}</button>)}</div></div>
      )}
      {mine.map((g) => (
        <div key={g.id} className="mb-4">
          <p className="mb-2 text-sm font-semibold">{g.name} <span className="font-normal text-ink-soft">{g.minSelect ? `choose ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}–${g.maxSelect}`}` : `optional, up to ${g.maxSelect}`}</span></p>
          <div className="flex flex-wrap gap-2">{g.options.map((o) => { const on = chosen[g.id]?.includes(o.id); return <button key={o.id} onClick={() => toggle(g, o.id)} className={`rounded-xl border-2 px-3 py-2 text-sm font-semibold ${on ? 'text-white' : 'border-line'}`} style={on ? { background: color, borderColor: color } : undefined}>{o.name}{o.priceDelta ? ` +${money(o.priceDelta)}` : ''}</button>; })}</div>
        </div>
      ))}
      <button disabled={!ok} onClick={() => onAdd({ key: uuid(), productId: product.id, name: product.name, qty: 1, unit: base + extra, variant, modifiers: mine.flatMap((g) => (chosen[g.id] ?? []).map((id) => ({ groupId: g.id, optionId: id, name: g.options.find((o) => o.id === id)?.name ?? '' }))) })} className="mt-2 w-full rounded-2xl px-5 py-4 text-lg font-bold text-white disabled:opacity-50" style={{ background: color }}>Add · {money(base + extra)}</button>
    </Sheet>
  );
}

function PayMpesa({ token, order, color, onClose, onPaid }: { token: string; order: GuestOrder; color: string; onClose: () => void; onPaid: () => void }) {
  const [phone, setPhone] = useState('');
  const [attempt, setAttempt] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!attempt) return;
    const t = setInterval(async () => {
      try {
        const r = await call<{ status: string; resultDesc?: string }>(`/t/${token}/orders/${order.id}/mpesa/${attempt}`);
        setStatus(r.status);
        if (r.status === 'succeeded') { clearInterval(t); onPaid(); }
        else if (!['pending', 'initiated'].includes(r.status)) { clearInterval(t); setErr(r.resultDesc ?? 'Payment not completed'); setAttempt(null); }
      } catch { /* keep trying */ }
    }, 2500);
    return () => clearInterval(t);
  }, [attempt]);
  async function send() {
    setErr('');
    try {
      const r = await call<{ attemptId: string }>(`/t/${token}/orders/${order.id}/mpesa`, { method: 'POST', body: JSON.stringify({ phone, idempotencyKey: uuid() }) });
      setAttempt(r.attemptId);
      setStatus('pending');
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  const amount = order.balance - (order.balance % 100);
  return (
    <Sheet title="Pay with M-Pesa" onClose={onClose}>
      <p className="text-3xl font-bold" style={{ color }}>{money(amount)}</p>
      {attempt ? (
        <p className="mt-4 flex items-center gap-3 rounded-2xl bg-warn-pale p-4 text-warn-ink"><Loader2 className="h-6 w-6 animate-spin" /> Check your phone and enter your M-Pesa PIN{status && status !== 'pending' ? ` (${status})` : ''}.</p>
      ) : (
        <>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Your M-Pesa number, e.g. 0712 345 678" className="mt-4 w-full rounded-xl border border-line bg-page px-3 py-3 text-lg" />
          <button disabled={phone.replace(/\D/g, '').length < 9} onClick={send} className="mt-3 w-full rounded-2xl px-5 py-4 text-lg font-bold text-white disabled:opacity-50" style={{ background: color }}>Send M-Pesa prompt</button>
        </>
      )}
      {err && <p className="mt-3 text-sm text-danger">{err}</p>}
    </Sheet>
  );
}
