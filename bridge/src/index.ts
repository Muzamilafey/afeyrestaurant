import { config } from './config';
import { api } from './api';
import { render, sendToNetworkPrinter, type PrintPayload } from './escpos';
import { state, type PrinterInfo } from './state';
import { startLocalServer } from './local';
import { ZktecoAdapter } from './devices/zkteco';
import { SecugenAdapter } from './devices/secugen';
import type { DeviceAdapter, DeviceInfo } from './devices/types';

function adapterFor(d: DeviceInfo): DeviceAdapter {
  if (d.vendor === 'zkteco') return new ZktecoAdapter(d);
  if (d.vendor === 'secugen') return new SecugenAdapter(d);
  throw new Error(`No adapter for vendor "${d.vendor}"`);
}

interface PollResp {
  printers: PrinterInfo[];
  jobs: Array<{ _id: string; printerId: string; kind: string; copy: 'original' | 'duplicate'; payload?: PrintPayload }>;
  commands: Array<{ _id: string; deviceId?: string; type: string; payload?: Record<string, any> }>;
  devices: DeviceInfo[];
}

async function processJobs(jobs: PollResp['jobs']) {
  for (const job of jobs) {
    const printer = state.printers.find((p) => String(p._id) === String(job.printerId));
    try {
      if (!printer) throw new Error('Printer not found');
      if (printer.connection !== 'network' || !printer.host) throw new Error(`${printer.connection} printers are not supported by this bridge yet — use a network (port 9100) printer`);
      const payload: PrintPayload = { ...(job.payload ?? {}), copy: job.copy };
      if (job.kind === 'test') payload.text = `${payload.text ?? 'Chili POS test print'}\n${new Date().toLocaleString()}\nPrinter: ${printer.name}`;
      await sendToNetworkPrinter(printer.host, printer.port ?? 9100, render(job.kind, payload, printer.paperWidth ?? 80));
      state.printerStatus.set(String(printer._id), { status: 'ok' });
      await api(`/bridge/print-jobs/${job._id}/result`, { body: { ok: true } });
    } catch (e) {
      // A failed print never affects the sale; it is reported so staff can retry or reprint.
      if (printer) state.printerStatus.set(String(printer._id), { status: 'error', error: (e as Error).message });
      await api(`/bridge/print-jobs/${job._id}/result`, { body: { ok: false, error: (e as Error).message.slice(0, 280) } }).catch(() => undefined);
    }
  }
}

async function pushAttendance(d: DeviceInfo) {
  const punches = await adapterFor(d).pullAttendance(d.lastSyncAt ? new Date(d.lastSyncAt) : undefined);
  for (let i = 0; i < punches.length; i += 1000) {
    const batch = punches.slice(i, i + 1000).map((p) => ({ ...p, at: p.at.toISOString() }));
    await api('/bridge/attendance', { body: { deviceId: d.id, events: batch } });
  }
  return punches.length;
}

async function processCommands(cmds: PollResp['commands']) {
  for (const c of cmds) {
    const d = state.devices.find((x) => String(x.id) === String(c.deviceId));
    try {
      if (!d) throw new Error('Device not assigned to this bridge');
      const a = adapterFor(d);
      let result: unknown;
      if (c.type === 'device_test') {
        result = await a.test();
        state.deviceStatus.set(String(d.id), { status: 'online', clockDriftSeconds: (result as { clockDriftSeconds?: number }).clockDriftSeconds });
      } else if (c.type === 'sync_time') result = await a.syncTime();
      else if (c.type === 'pull_attendance') result = { pulled: await pushAttendance(d) };
      else if (c.type === 'list_users') result = await a.listUsers();
      else if (c.type === 'enroll_user') result = await a.enrollUser({ deviceUserCode: c.payload!.deviceUserCode, name: c.payload!.name, fingerIndex: c.payload!.fingerIndex ?? 0 });
      else if (c.type === 'delete_user') result = await a.deleteUser(c.payload!.deviceUserCode);
      else throw new Error(`Unknown command ${c.type}`);
      await api(`/bridge/commands/${c._id}/result`, { body: { ok: true, result } });
    } catch (e) {
      if (d) state.deviceStatus.set(String(d.id), { status: 'error', error: (e as Error).message });
      await api(`/bridge/commands/${c._id}/result`, { body: { ok: false, error: (e as Error).message.slice(0, 480) } }).catch(() => undefined);
    }
  }
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const r = await api<PollResp>('/bridge/poll');
    state.printers = r.printers;
    state.devices = r.devices;
    await processJobs(r.jobs);
    await processCommands(r.commands);
  } catch (e) {
    console.error('[bridge] poll failed:', (e as Error).message);
  } finally {
    polling = false;
  }
}

async function heartbeat() {
  try {
    await api('/bridge/heartbeat', {
      body: {
        version: config.version,
        capabilities: ['escpos_network', 'cash_drawer', 'zkteco', 'secugen_webapi'],
        diagnostics: { platform: process.platform, node: process.version, uptime: Math.round(process.uptime()), tz: process.env.TZ },
        devices: [...state.deviceStatus.entries()].map(([id, s]) => ({ id, ...s })),
        printers: [...state.printerStatus.entries()].map(([id, s]) => ({ id, ...s })),
      },
    });
  } catch (e) {
    console.error('[bridge] heartbeat failed:', (e as Error).message);
  }
}

async function scheduledAttendance() {
  for (const d of state.devices.filter((x) => x.vendor === 'zkteco')) {
    try {
      const n = await pushAttendance(d);
      state.deviceStatus.set(String(d.id), { status: 'online' });
      if (n) console.log(`[bridge] ${n} punches from ${d.model ?? d.host}`);
    } catch (e) {
      state.deviceStatus.set(String(d.id), { status: 'offline', error: (e as Error).message });
    }
  }
}

async function main() {
  console.log(`[bridge] Chili Bridge ${config.version} → ${config.apiUrl}`);
  startLocalServer();
  await heartbeat();
  await poll();
  setInterval(poll, config.pollMs);
  setInterval(heartbeat, 30_000);
  setInterval(scheduledAttendance, config.attendancePullMs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
