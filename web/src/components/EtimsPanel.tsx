import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Send, ShieldCheck } from 'lucide-react';
import { get, post } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { Button, DataTable, Pill } from '@/components/ui';
import { useFeedback } from '@/components/feedback';

interface Invoice { _id: string; invcNo: number; kind: 'sale' | 'credit_note'; orderNumber?: string; receiptNumber?: string; amount: number; status: 'queued' | 'signed' | 'rejected' | 'duplicate'; attempts: number; lastError?: string; createdAt: string; signedAt?: string; simulated?: boolean; result?: { sdcId?: string; curRcptNo?: number } }
interface Status { enabled: boolean; simulated: boolean; series: string | null; problem: string | null; hasKey: boolean; lastInvcNo: number | null; counts: Record<string, number>; recent: Invoice[]; failing: Invoice[] }

const STATUS: Record<Invoice['status'], { label: string; color: 'green' | 'yellow' | 'red' | 'gray' }> = {
  signed: { label: 'Signed', color: 'green' }, queued: { label: 'Waiting', color: 'yellow' }, rejected: { label: 'Refused', color: 'red' }, duplicate: { label: 'Already at KRA', color: 'gray' },
};

/** Integrations → KRA eTIMS: device initialisation and the invoices sent to KRA. */
export function EtimsPanel({ settings, environment, simulated, onInitialized }: { settings: Record<string, string>; environment: string; simulated: boolean; onInitialized: (s: Record<string, string>) => void }) {
  const { handleError, toast } = useFeedback();
  const qc = useQueryClient();
  const { data } = useQuery<Status>({ queryKey: ['etims'], queryFn: () => get('/etims'), refetchInterval: 15_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['etims'] }); qc.invalidateQueries({ queryKey: ['integrations'] }); };

  const initialize = () =>
    post<{ sdcId?: string; taxpayerName?: string; simulated: boolean }>('/etims/initialize', simulated ? { tin: settings.tin || 'P000000000A', bhfId: settings.bhfId || '00', deviceSerial: settings.deviceSerial || 'SIMULATED', simulated } : { tin: settings.tin, bhfId: settings.bhfId || '00', deviceSerial: settings.deviceSerial, environment, simulated })
      .then((r) => { onInitialized({ tin: (settings.tin ?? '').toUpperCase(), bhfId: settings.bhfId || '00' }); refresh(); toast(`${r.simulated ? 'SIMULATED: ' : ''}Device initialised${r.taxpayerName ? ` for ${r.taxpayerName}` : ''}${r.sdcId ? ` · CU ${r.sdcId}` : ''}`); })
      .catch(handleError);

  const rows = [...(data?.failing ?? []), ...(data?.recent ?? []).filter((r) => !data?.failing.some((f) => f._id === r._id))];
  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">Device &amp; invoices</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<ShieldCheck className="h-4 w-4" />} disabled={!simulated && (!settings.tin || !settings.deviceSerial)} onClick={initialize}>Initialise device</Button>
          <Button size="sm" variant="secondary" icon={<Send className="h-4 w-4" />} disabled={!data?.enabled} onClick={() => post('/etims/send', {}).then(() => { refresh(); toast('Sent what was waiting'); }).catch(handleError)}>Send now</Button>
        </div>
      </div>
      <p className="text-xs text-ink-soft">Initialise once with the PIN, branch ID and OSCU serial above (save them first). KRA returns the communication key, stored encrypted. Every paid sale is then signed by KRA and its signature and QR code print on the receipt; refunds are sent as credit notes. If KRA or the internet is down, sales continue and are sent later with the same invoice number.</p>
      {data?.problem && data.enabled && <p className="rounded-xl bg-danger-pale p-3 text-sm text-danger">{data.problem}</p>}
      {data && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Pill color="green">{data.counts.signed ?? 0} signed</Pill>
          {(data.counts.queued ?? 0) > 0 && <Pill color="yellow">{data.counts.queued} waiting</Pill>}
          {(data.counts.rejected ?? 0) > 0 && <Pill color="red">{data.counts.rejected} refused</Pill>}
          {(data.counts.duplicate ?? 0) > 0 && <Pill>{data.counts.duplicate} already at KRA</Pill>}
          {data.lastInvcNo !== null && <Pill color="blue">Last invoice no. {data.lastInvcNo}</Pill>}
          {data.series && <Pill>{data.series}</Pill>}
        </div>
      )}
      {rows.length > 0 && (
        <DataTable rows={rows} rowKey={(r) => r._id} columns={[
          { key: 'n', header: 'No.', render: (r) => <b className="tabular-nums">{r.invcNo}</b> },
          { key: 'o', header: 'Sale', render: (r) => <div><p>{r.receiptNumber ?? r.orderNumber}</p><p className="text-xs text-ink-soft">{r.kind === 'credit_note' ? 'Credit note (refund)' : 'Sale'} · {dateTime(r.createdAt)}</p></div> },
          { key: 'a', header: 'Amount', render: (r) => (r.kind === 'credit_note' ? `-${money(r.amount)}` : money(r.amount)) },
          { key: 's', header: 'KRA', render: (r) => (
            <div className="max-w-xs">
              <Pill color={STATUS[r.status].color}>{STATUS[r.status].label}</Pill>{r.simulated && <Pill color="yellow" className="ml-1">simulated</Pill>}
              {r.status === 'signed' && r.result?.curRcptNo ? <p className="text-xs text-ink-soft">{r.result.sdcId}/{r.result.curRcptNo}</p> : null}
              {r.lastError && r.status !== 'signed' && <p className="text-xs text-danger">{r.lastError}{r.attempts > 1 ? ` (tried ${r.attempts}×)` : ''}</p>}
            </div>
          ) },
          { key: 'x', header: '', render: (r) => (r.status === 'rejected' || r.status === 'duplicate') && <Button size="sm" variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => post(`/etims/invoices/${r._id}/retry`, {}).then(() => { refresh(); toast(`Invoice ${r.invcNo} resent`); }).catch(handleError)}>Resend</Button> },
        ]} />
      )}
    </div>
  );
}
