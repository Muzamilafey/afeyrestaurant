import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required setting ${name} (see .env.example)`);
  return v;
}

// Attendance terminals report wall-clock times without a zone; decode them in the devices' zone.
process.env.TZ = process.env.DEVICE_TZ || 'Africa/Nairobi';

export const config = {
  apiUrl: req('CHILI_API_URL').replace(/\/+$/, ''),
  token: req('CHILI_BRIDGE_TOKEN'),
  pollMs: Math.max(2, Number(process.env.POLL_SECONDS ?? 4)) * 1000,
  localPort: Number(process.env.LOCAL_PORT ?? 9632),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  localToken: process.env.LOCAL_TOKEN ?? '',
  attendancePullMs: Math.max(1, Number(process.env.ATTENDANCE_PULL_MINUTES ?? 5)) * 60_000,
  secugenUrl: (process.env.SECUGEN_WEBAPI_URL ?? 'https://localhost:8443').replace(/\/+$/, ''),
  secugenLicense: process.env.SECUGEN_LICENSE ?? '',
  templateKey: process.env.TEMPLATE_KEY ?? '',
  version: '0.1.0',
};
