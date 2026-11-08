import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { ExternalLink, Printer, QrCode, RefreshCw } from 'lucide-react';
import { get, patch, post } from '@/lib/api';
import { Button, Card, Modal, Toggle } from '@/components/ui';
import { useFeedback } from '@/components/feedback';
import { useAuth } from '@/auth/AuthContext';

interface QrSettings { enabled: boolean; requireAccept: boolean; payByMpesa: boolean }
interface Code { tableId: string; number: string; area: string | null; path: string }

const DEFAULTS: QrSettings = { enabled: false, requireAccept: true, payByMpesa: true };

/** Settings → Tables: let guests order from a QR sticker on their table, and print the stickers. */
export function QrOrderingSettings() {
  const { branch, can } = useAuth();
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data: branches } = useQuery<Array<{ _id: string; name: string; settings?: { qrOrdering?: Partial<QrSettings> } }>>({ queryKey: ['branches'], queryFn: () => get('/admin/branches') });
  const current = branches?.find((b) => b._id === branch?.id);
  const s: QrSettings = { ...DEFAULTS, ...current?.settings?.qrOrdering };
  const [codesOpen, setCodesOpen] = useState(false);
  const manage = can('branches.manage');

  const save = (next: Partial<QrSettings>) => {
    if (!current) return;
    // The whole object is sent so the branch keeps every QR option.
    patch(`/admin/branches/${current._id}`, { settings: { qrOrdering: { ...s, ...next } } })
      .then(() => { qc.invalidateQueries({ queryKey: ['branches'] }); toast('QR ordering updated'); })
      .catch(handleError);
  };

  return (
    <Card title="QR table ordering" actions={<Button size="sm" variant="secondary" icon={<QrCode className="h-4 w-4" />} onClick={() => setCodesOpen(true)}>QR codes</Button>}>
      <p className="mb-3 text-sm text-ink-soft">
        Guests scan the code on their table to see the menu, order, call a waiter, ask for the bill or pay by M-Pesa. Orders appear on the POS and Tables screens with a chime.
      </p>
      <div className="flex flex-col items-start gap-3">
        <Toggle checked={s.enabled} disabled={!manage || !current} onChange={(v) => save({ enabled: v })} label={`Allow ordering from the table QR code${current ? ` (${current.name})` : ''}`} />
        <Toggle checked={s.requireAccept} disabled={!manage || !current || !s.enabled} onChange={(v) => save({ requireAccept: v })} label="A waiter accepts each QR order before it goes to the kitchen/bar" />
        <Toggle checked={s.payByMpesa} disabled={!manage || !current || !s.enabled} onChange={(v) => save({ payByMpesa: v })} label="Guests can pay the bill by M-Pesa prompt from their phone" />
        {!manage && <p className="text-xs text-ink-soft">Only users who manage branches can change these.</p>}
      </div>
      {codesOpen && <QrCodesDialog enabled={s.enabled} onClose={() => setCodesOpen(false)} />}
    </Card>
  );
}

function QrCodesDialog({ enabled, onClose }: { enabled: boolean; onClose: () => void }) {
  const { handleError, toast, confirm } = useFeedback();
  const qc = useQueryClient();
  const { data: codes, isLoading } = useQuery<Code[]>({ queryKey: ['qr-codes'], queryFn: () => get('/qr/codes') });
  const [images, setImages] = useState<Record<string, string>>({});
  const url = (c: Code) => `${window.location.origin}${c.path}`;

  useEffect(() => {
    if (!codes) return;
    let live = true;
    Promise.all(codes.map(async (c) => [c.tableId, await QRCode.toDataURL(url(c), { margin: 1, width: 360, errorCorrectionLevel: 'M' })] as const))
      .then((pairs) => live && setImages(Object.fromEntries(pairs)))
      .catch(handleError);
    return () => { live = false; };
  }, [codes, handleError]);

  const regenerate = async (c: Code) => {
    const r = await confirm({ title: `New QR code for table ${c.number}?`, message: 'The printed sticker on this table stops working. Print and stick the new one.', confirmLabel: 'Make new code', danger: true });
    if (!r.ok) return;
    post(`/qr/codes/${c.tableId}/regenerate`, {}).then(() => { qc.invalidateQueries({ queryKey: ['qr-codes'] }); toast(`Table ${c.number} has a new QR code`); }).catch(handleError);
  };

  const print = () => {
    if (!codes) return;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return toast('Allow pop-ups to print the QR codes', 'error');
    const esc = (v: string) => v.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    const cards = codes.map((c) => `<div class="c"><p class="t">Table ${esc(c.number)}</p>${c.area ? `<p class="a">${esc(c.area)}</p>` : ''}<img src="${images[c.tableId] ?? ''}" alt=""><p class="h">Scan to see the menu and order</p></div>`).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Table QR codes</title><style>
      body{font-family:system-ui,sans-serif;margin:0;padding:12mm}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}
      .c{border:1px dashed #999;border-radius:4mm;padding:5mm;text-align:center;break-inside:avoid}.t{font-size:20pt;font-weight:700;margin:0}
      .a{margin:0;color:#555}.h{margin:2mm 0 0;font-size:10pt}img{width:100%;max-width:55mm}
    </style></head><body><div class="g">${cards}</div><script>window.onload=()=>{window.print()}</script></body></html>`);
    w.document.close();
  };

  return (
    <Modal open onClose={onClose} title="Table QR codes" size="lg" footer={<Button icon={<Printer className="h-4 w-4" />} disabled={!codes?.length || Object.keys(images).length < (codes?.length ?? 0)} onClick={print}>Print all</Button>}>
      {/^(localhost|127\.|\[::1\])/.test(window.location.hostname) && <p className="mb-3 rounded-xl bg-danger-pale p-3 text-sm text-danger">You opened Chili POS as “{window.location.hostname}”, which guests’ phones can’t reach. Open it by the address phones use (your Wi-Fi IP or web address) before printing.</p>}
      {!enabled && <p className="mb-3 rounded-xl bg-warn-pale p-3 text-sm text-warn-ink">QR ordering is off — guests who scan see “please ask a waiter” until you switch it on.</p>}
      {isLoading ? <p className="text-sm text-ink-soft">Loading…</p> : !codes?.length ? <p className="text-sm text-ink-soft">Add tables first.</p> : (
        <div className="grid gap-3 sm:grid-cols-3">
          {codes.map((c) => (
            <div key={c.tableId} className="rounded-2xl border border-line p-3 text-center">
              <p className="font-bold">Table {c.number}</p>
              {c.area && <p className="text-xs text-ink-soft">{c.area}</p>}
              {images[c.tableId] ? <img src={images[c.tableId]} alt={`QR code for table ${c.number}`} className="mx-auto my-2 w-36 rounded-lg bg-white p-1" /> : <div className="mx-auto my-2 h-36 w-36 animate-pulse rounded-lg bg-page" />}
              <div className="flex justify-center gap-1">
                <a href={c.path} target="_blank" rel="noreferrer" className="btn-ghost !min-h-[32px] !text-xs"><ExternalLink className="h-3.5 w-3.5" /> Open</a>
                <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => regenerate(c)} className="whitespace-nowrap">New code</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
