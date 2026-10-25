import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Smartphone } from 'lucide-react';
import { money } from '@/lib/format';
import { lastPublished, onDisplayMessage, type DisplayState } from '@/lib/customerDisplay';

const TOKEN = 'chili.display.token';
interface Biz { name?: string; logoUrl?: string | null; color?: string }

/**
 * The screen the customer sees. Opened from the till as a second window (same PC, instant) or on a tablet paired with
 * a 6-digit code (updates about every second through the server). Shows only the order being paid — nothing else.
 */
export default function CustomerDisplay() {
  const [state, setState] = useState<DisplayState | null>(() => lastPublished());
  const [biz, setBiz] = useState<Biz>({});
  const [token, setToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem(TOKEN);
    } catch {
      return null;
    }
  });
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [local, setLocal] = useState(false);

  // Same PC: the till window talks to this window directly.
  useEffect(() => onDisplayMessage((s) => { setLocal(true); setState(s); }), []);
  useEffect(() => {
    fetch('/api/v1/business').then((r) => r.json()).then((j) => setBiz({ name: j.data?.name, logoUrl: j.data?.logoUrl, color: j.data?.primaryColor })).catch(() => undefined);
    document.title = 'Customer display';
  }, []);
  // Paired tablet: poll the screen published for this display.
  useEffect(() => {
    if (!token) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/v1/display/screen', { headers: { Authorization: `Display ${token}` } });
        if (r.status === 401) {
          localStorage.removeItem(TOKEN);
          setToken(null);
          return;
        }
        const j = await r.json();
        if (j.data) {
          setBiz(j.data.business);
          setState(j.data.state);
        }
      } catch {
        /* offline for a moment: keep the last screen */
      }
      if (!stop) setTimeout(tick, 1000);
    };
    tick();
    return () => { stop = true; };
  }, [token]);

  async function pair() {
    setError('');
    try {
      const r = await fetch('/api/v1/display/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'chili-pos' }, body: JSON.stringify({ code }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message ?? 'Pairing failed');
      localStorage.setItem(TOKEN, j.data.token);
      setToken(j.data.token);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const color = biz.color ?? '#07963C';
  const s = state;
  const showPair = !token && !local && (!s || s.stage === 'idle');

  return (
    <div className="flex min-h-screen flex-col bg-page text-ink" style={{ ['--brand' as string]: color }}>
      <header className="flex items-center gap-4 px-8 py-5 text-white" style={{ background: color }}>
        {biz.logoUrl ? <img src={biz.logoUrl} alt="" className="h-14 w-14 rounded-2xl bg-white object-contain p-1" /> : null}
        <p className="text-3xl font-bold">{biz.name ?? 'Welcome'}</p>
        {s?.orderNumber && s.stage !== 'idle' && <p className="ml-auto text-lg opacity-90">Order {s.orderNumber}</p>}
      </header>

      {!s || s.stage === 'idle' || (!s.lines.length && s.stage === 'order') ? (
        <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          {biz.logoUrl && <img src={biz.logoUrl} alt="" className="h-40 w-40 rounded-3xl object-contain" />}
          <p className="text-5xl font-bold">Karibu!</p>
          <p className="text-2xl text-ink-soft">Welcome to {biz.name ?? 'our restaurant'}</p>
          {showPair && (
            <div className="mt-10 w-full max-w-sm rounded-2xl border border-line bg-card p-5 text-left">
              <p className="font-semibold">Use this screen as a customer display</p>
              <p className="mt-1 text-sm text-ink-soft">On the till: account menu → Customer display → Pair a tablet, then enter the code here.</p>
              <div className="mt-3 flex gap-2">
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="6-digit code" className="flex-1 rounded-xl border border-line bg-page px-3 py-2 text-lg tracking-widest" aria-label="Pairing code" />
                <button onClick={pair} disabled={code.length !== 6} className="rounded-xl px-4 py-2 font-semibold text-white disabled:opacity-50" style={{ background: color }}>Pair</button>
              </div>
              {error && <p className="mt-2 text-sm text-danger">{error}</p>}
            </div>
          )}
        </main>
      ) : (
        <main className="grid flex-1 gap-6 p-8 lg:grid-cols-[1.4fr_1fr]">
          <section className="rounded-3xl bg-card p-6 shadow-soft">
            <ul className="divide-y divide-line text-xl">
              {s.lines.map((l, i) => (
                <li key={i} className="flex items-start justify-between gap-4 py-3">
                  <span>
                    <b className="mr-2 tabular-nums">{l.qty}×</b>{l.name}
                    {l.parts?.length ? <span className="block text-base text-ink-soft">{l.parts.join(', ')}</span> : null}
                  </span>
                  <span className="whitespace-nowrap font-semibold tabular-nums">{money(l.total)}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-4">
            <div className="rounded-3xl bg-card p-6 shadow-soft">
              {s.subtotal !== s.total && <p className="flex justify-between text-xl text-ink-soft"><span>Subtotal</span><span className="tabular-nums">{money(s.subtotal)}</span></p>}
              {s.paid > 0 && s.stage !== 'paid' && <p className="flex justify-between text-xl text-ink-soft"><span>Paid</span><span className="tabular-nums">{money(s.paid)}</span></p>}
              {s.tip ? <p className="flex justify-between text-xl text-ink-soft"><span>Tip — thank you!</span><span className="tabular-nums">{money(s.tip)}</span></p> : null}
              <p className="mt-2 text-lg font-semibold uppercase text-ink-soft">{s.stage === 'paid' ? 'Total paid' : s.paid > 0 ? 'Balance to pay' : 'Total'}</p>
              <p className="text-6xl font-bold tabular-nums" style={{ color }}>{money(s.stage === 'paid' ? s.total + (s.tip ?? 0) : s.balance + (s.tip ?? 0))}</p>
            </div>
            {s.stage === 'mpesa' && (
              <div className="flex items-center gap-4 rounded-3xl bg-warn-pale p-6 text-warn-ink">
                <Smartphone className="h-12 w-12 shrink-0" />
                <div><p className="text-2xl font-bold">Check your phone</p><p className="text-lg">{s.message ?? 'Enter your M-Pesa PIN to pay'}</p></div>
                <Loader2 className="ml-auto h-8 w-8 animate-spin" />
              </div>
            )}
            {s.stage === 'pay' && s.message && <div className="rounded-3xl bg-brand-pale p-6 text-2xl font-semibold text-brand-dark">{s.message}</div>}
            {s.stage === 'paid' && (
              <div className="flex items-center gap-4 rounded-3xl p-6 text-white" style={{ background: color }}>
                <CheckCircle2 className="h-14 w-14 shrink-0" />
                <div>
                  <p className="text-3xl font-bold">Asante! Thank you</p>
                  <p className="text-lg opacity-90">{s.payerName ? `Paid by ${s.payerName}` : 'Payment received'}{s.change ? ` · Change ${money(s.change)}` : ''}{s.receiptNumber ? ` · Receipt ${s.receiptNumber}` : ''}</p>
                </div>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
