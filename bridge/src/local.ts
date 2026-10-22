import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config';
import { api } from './api';
import { capture, identify } from './devices/secugen';
import { render, sendToNetworkPrinter } from './escpos';
import { state } from './state';

/**
 * Localhost-only HTTP server:
 *  - GET  /health            bridge status (for the POS to detect the bridge)
 *  - POST /print             print text on a configured printer (POS browser → bridge; origin + token checked)
 *  - GET  /clock             SecuGen fingerprint clock-in/out kiosk page
 *  - POST /clock             capture + identify + record an attendance event
 */
const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Local-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  }
  return !origin || config.allowedOrigins.includes(origin);
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req: http.IncomingMessage) {
  let data = '';
  for await (const c of req) {
    data += c;
    if (data.length > 256_000) throw new Error('Body too large');
  }
  return data ? JSON.parse(data) : {};
}

const KIOSK = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clock in</title>
<style>body{margin:0;font-family:Inter,Segoe UI,sans-serif;background:#111412;color:#fff;display:grid;place-items:center;min-height:100vh}main{text-align:center}button{font-size:22px;padding:22px 36px;margin:8px;border:0;border-radius:18px;background:#07963C;color:#fff;cursor:pointer}button.out{background:#2b2f2d}#msg{margin-top:24px;font-size:20px;min-height:28px}</style></head>
<body><main><h1>Place your finger on the reader</h1><p>Choose an action, then scan.</p>
<div><button data-t="clock_in">Clock in</button><button class="out" data-t="clock_out">Clock out</button></div><div><button class="out" data-t="break_start">Start break</button><button class="out" data-t="break_end">End break</button></div><div id="msg"></div></main>
<script>for(const b of document.querySelectorAll('button'))b.onclick=async()=>{const m=document.getElementById('msg');m.textContent='Scanning…';try{const r=await fetch('/clock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:b.dataset.t})});const j=await r.json();m.textContent=j.message}catch(e){m.textContent='Bridge error'}}</script></body></html>`;

export function startLocalServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (!cors(req, res)) return json(res, 403, { error: 'Origin not allowed' });
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, version: config.version, printers: state.printers.map((p) => ({ id: p._id, name: p.name, role: p.role })), devices: state.devices.length });

      if (req.method === 'POST' && url.pathname === '/print') {
        const token = String(req.headers['x-bridge-local-token'] ?? '');
        if (!config.localToken || !safeEq(token, config.localToken)) return json(res, 401, { error: 'Invalid local token' });
        const body = await readBody(req);
        const printer = state.printers.find((p) => String(p._id) === body.printerId) ?? state.printers.find((p) => p.role === (body.role ?? 'receipt'));
        if (!printer?.host) return json(res, 404, { error: 'No network printer configured for this role' });
        await sendToNetworkPrinter(printer.host, printer.port ?? 9100, render(body.kind ?? 'receipt', { text: String(body.text ?? ''), copy: body.copy, openDrawer: !!body.openDrawer }, printer.paperWidth ?? 80));
        return json(res, 200, { ok: true });
      }

      // The kiosk is only reachable from this PC (server binds to 127.0.0.1).
      if (url.pathname === '/clock') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
          return res.end(KIOSK);
        }
        const device = state.devices.find((d) => d.vendor === 'secugen');
        if (!device) return json(res, 404, { message: 'No SecuGen reader is registered for this bridge' });
        const body = await readBody(req);
        const type = ['clock_in', 'clock_out', 'break_start', 'break_end'].includes(body.type) ? body.type : 'unknown';
        const scan = await capture();
        const code = await identify(scan.template);
        if (!code) return json(res, 200, { message: 'Fingerprint not recognised. Try again or use your PIN at the POS.' });
        const r = await api<{ inserted: number }>('/bridge/attendance', { body: { deviceId: device.id, events: [{ userCode: code, at: new Date().toISOString(), punch: type, verifyMode: 'fingerprint' }] } });
        return json(res, 200, { message: r.inserted ? `Recorded ${type.replace('_', ' ')} at ${new Date().toLocaleTimeString()}` : 'Already recorded' });
      }
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      json(res, 500, { error: (e as Error).message, message: (e as Error).message });
    }
  });
  server.listen(config.localPort, '127.0.0.1', () => console.log(`[bridge] local server on http://127.0.0.1:${config.localPort}`));
  return server;
}
