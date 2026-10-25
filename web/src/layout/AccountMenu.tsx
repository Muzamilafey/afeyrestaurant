import { useState } from 'react';
import { KeyRound, MonitorSmartphone, Lock, Download, Printer, Tv } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, Input, Modal, Pill, Select } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';
import { get, post } from '@/lib/api';
import { getTillReceiptPrinter, setTillReceiptPrinter } from '@/lib/till';
import { getDisplayPairing, setDisplayPairing } from '@/lib/customerDisplay';
import { useInstallPrompt } from '@/components/pwa';

/** Available to every signed-in user: change own PIN; managers can also register the device as a PIN terminal. */
export function AccountMenu({ onClose }: { onClose: () => void }) {
  const { session, can, terminalToken, setTerminalToken, logout } = useAuth();
  const { toast, handleError } = useFeedback();
  const [pin, setPin] = useState({ current: '', next: '', confirm: '', password: '' });
  const [usePassword, setUsePassword] = useState(false);
  const [terminalName, setTerminalName] = useState('Till 1');
  const app = useInstallPrompt();
  const canSetupTill = can('terminals.manage') || can('integrations.manage');
  const printers = useQuery<Array<{ _id: string; name: string; role: string; connection: string; active: boolean }>>({ queryKey: ['printers'], queryFn: () => get('/integrations/printers'), enabled: can('orders.view') });
  const [tillPrinter, setTillPrinter] = useState(getTillReceiptPrinter);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  const [display, setDisplay] = useState(getDisplayPairing);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const pairTablet = async () => {
    try {
      const r = await post<{ pairingId: string; code: string }>('/display/pair', { name: `Display · ${session?.user.name ?? 'till'}` });
      setDisplayPairing({ id: r.pairingId, name: 'Customer display' });
      setDisplay({ id: r.pairingId, name: 'Customer display' });
      setPairCode(r.code);
    } catch (e) {
      handleError(e);
    }
  };

  const changePin = async () => {
    if (pin.next !== pin.confirm) return toast('The new PINs do not match', 'error');
    try {
      await post('/auth/pin', usePassword ? { currentPassword: pin.password, pin: pin.next } : { currentPin: pin.current, pin: pin.next });
      toast('Your PIN has been changed');
      setPin({ current: '', next: '', confirm: '', password: '' });
    } catch (e) {
      handleError(e);
    }
  };
  const registerDevice = async () => {
    try {
      const r = await post<{ terminalToken: string; name: string }>('/auth/terminal/register', { name: terminalName });
      setTerminalToken(r.terminalToken);
      toast(`This device is now “${r.name}”. Staff can sign in with their PIN.`);
    } catch (e) {
      handleError(e);
    }
  };

  return (
    <Modal open onClose={onClose} title={session?.user.name ?? 'My account'} footer={<Button variant="secondary" icon={<Lock className="h-4 w-4" />} onClick={() => { onClose(); logout(); }}>{terminalToken ? 'Switch user' : 'Sign out'}</Button>}>
      <div className="space-y-5">
        <section className="space-y-3">
          <p className="flex items-center gap-2 font-semibold"><KeyRound className="h-4 w-4 text-brand" /> Change my PIN</p>
          <p className="text-xs text-ink-soft">Your PIN is used to sign in on POS terminals and to approve actions. 4–6 digits, numbers only; avoid 1111 or 1234.</p>
          {usePassword ? (
            <Field label="Password"><Input type="password" value={pin.password} onChange={(e) => setPin({ ...pin, password: e.target.value })} /></Field>
          ) : (
            <Field label="Current PIN"><Input type="password" inputMode="numeric" autoComplete="off" value={pin.current} onChange={(e) => setPin({ ...pin, current: digits(e.target.value) })} /></Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="New PIN"><Input type="password" inputMode="numeric" autoComplete="off" value={pin.next} onChange={(e) => setPin({ ...pin, next: digits(e.target.value) })} /></Field>
            <Field label="Confirm new PIN"><Input type="password" inputMode="numeric" autoComplete="off" value={pin.confirm} onChange={(e) => setPin({ ...pin, confirm: digits(e.target.value) })} /></Field>
          </div>
          <div className="flex items-center justify-between">
            <button className="text-xs font-semibold text-brand" onClick={() => setUsePassword(!usePassword)}>{usePassword ? 'Use my current PIN instead' : 'No PIN yet / forgot it? Use my password'}</button>
            <Button size="sm" disabled={pin.next.length < 4 || (usePassword ? !pin.password : pin.current.length < 4)} onClick={changePin}>Save PIN</Button>
          </div>
        </section>
        {(app.installed || app.canInstall || app.ios) && (
          <section className="space-y-3 border-t border-line pt-4">
            <p className="flex items-center gap-2 font-semibold"><Download className="h-4 w-4 text-brand" /> App on this device</p>
            {app.installed ? (
              <Pill color="green">Running as an installed app</Pill>
            ) : app.canInstall ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-soft">Install for a full-screen till with its own icon that starts even when the internet is down.</p>
                <Button size="sm" onClick={async () => { if (await app.install()) toast('Installed — open it from your home screen or desktop'); }}>Install</Button>
              </div>
            ) : (
              <p className="text-xs text-ink-soft">On iPhone or iPad: tap <b>Share</b> in Safari, then <b>Add to Home Screen</b>.</p>
            )}
          </section>
        )}
        {canSetupTill && (
          <section className="space-y-3 border-t border-line pt-4">
            <p className="flex items-center gap-2 font-semibold"><Printer className="h-4 w-4 text-brand" /> Receipt printer for this till</p>
            <p className="text-xs text-ink-soft">With several tills, point each one at the printer beside it. Saved on this device only.</p>
            <Select
              aria-label="Receipt printer for this till"
              value={tillPrinter}
              onChange={(e) => {
                setTillReceiptPrinter(e.target.value);
                setTillPrinter(e.target.value);
                toast('Receipt printer for this till saved');
              }}
            >
              <option value="">Automatic — the branch receipt printer</option>
              <option value="browser">This computer’s print dialog</option>
              {(printers.data ?? []).filter((p) => p.active && p.connection !== 'browser').map((p) => <option key={p._id} value={p._id}>{p.name} · {p.role}</option>)}
            </Select>
          </section>
        )}
        {can('orders.create') && (
          <section className="space-y-3 border-t border-line pt-4">
            <p className="flex items-center gap-2 font-semibold"><Tv className="h-4 w-4 text-brand" /> Customer display</p>
            <p className="text-xs text-ink-soft">Shows the customer their order, the amount to pay, the M-Pesa prompt and “thank you”.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => window.open('/display', 'chili-customer-display', 'popup,width=1280,height=800')}>Open on a second screen</Button>
              <Button size="sm" variant="secondary" onClick={pairTablet}>{display ? 'Pair another tablet' : 'Pair a tablet'}</Button>
              {display && <Button size="sm" variant="ghost" onClick={() => { setDisplayPairing(null); setDisplay(null); setPairCode(null); toast('This till no longer sends to the tablet'); }}>Stop sending to tablet</Button>}
            </div>
            {pairCode && <p className="rounded-xl bg-brand-pale p-3 text-sm text-brand-dark">On the tablet open <b>{window.location.origin}/display</b> and enter <b className="text-lg tracking-widest">{pairCode}</b> (valid 10 minutes).</p>}
            {display && !pairCode && <p className="text-xs text-ink-soft">This till sends its screen to a paired tablet.</p>}
          </section>
        )}
        {can('terminals.manage') && (
          <section className="space-y-3 border-t border-line pt-4">
            <p className="flex items-center gap-2 font-semibold"><MonitorSmartphone className="h-4 w-4 text-brand" /> PIN sign-in on this device</p>
            {terminalToken ? (
              <div className="flex items-center justify-between gap-3"><Pill color="green">This device is a registered terminal</Pill><Button size="sm" variant="ghost" onClick={() => { setTerminalToken(null); toast('PIN sign-in removed from this device'); }}>Remove</Button></div>
            ) : (
              <>
                <p className="text-xs text-ink-soft">Registers this device for <b>{session?.branches.length ? 'the current branch' : 'your branch'}</b>. Staff then sign in by tapping their name and entering their PIN. Only do this on the restaurant’s own tills and tablets.</p>
                <div className="flex gap-2"><Input value={terminalName} onChange={(e) => setTerminalName(e.target.value)} placeholder="Device name" /><Button onClick={registerDevice}>Use this device</Button></div>
              </>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
