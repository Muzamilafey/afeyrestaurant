import type { DeviceAdapter, DeviceInfo, Punch } from './types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Zkteco = require('zkteco-js');

/**
 * ZKTeco standalone/network attendance terminals over the ZK protocol (UDP/TCP 4370), via the open-source
 * zkteco-js library. Status: UNVERIFIED — compatible with many ZK firmware versions, but each model must be
 * tested physically before it is marked verified in Chili POS.
 */
const PUNCH: Record<number, Punch['punch']> = { 0: 'clock_in', 1: 'clock_out', 2: 'break_start', 3: 'break_end', 4: 'clock_in', 5: 'clock_out' };
const VERIFY: Record<number, string> = { 0: 'password', 1: 'fingerprint', 2: 'card', 15: 'face' };

export class ZktecoAdapter implements DeviceAdapter {
  constructor(private d: DeviceInfo) {
    if (!d.host) throw new Error('ZKTeco device has no IP address');
  }

  private async session<T>(fn: (zk: any) => Promise<T>): Promise<T> {
    const zk = new Zkteco(this.d.host, this.d.port ?? 4370, 10000, 5200);
    try {
      await zk.createSocket();
      return await fn(zk);
    } finally {
      await zk.disconnect().catch(() => undefined);
    }
  }

  test() {
    return this.session(async (zk) => {
      const [info, serial, name, time] = await Promise.all([zk.getInfo(), zk.getSerialNumber().catch(() => null), zk.getDeviceName().catch(() => null), zk.getTime().catch(() => null)]);
      const drift = time ? Math.round((new Date(time).getTime() - Date.now()) / 1000) : undefined;
      return { ok: true as const, details: { info, serial, name }, clockDriftSeconds: drift };
    });
  }

  syncTime() {
    return this.session(async (zk) => {
      await zk.setTime(new Date());
    });
  }

  pullAttendance(since?: Date) {
    return this.session(async (zk) => {
      const res = await zk.getAttendances();
      const out: Punch[] = [];
      for (const r of (res?.data ?? []) as Array<{ user_id: string; record_time: string; state: number; type: number }>) {
        // record_time is the device's local wall-clock time, decoded in DEVICE_TZ (see config.ts).
        const at = new Date(r.record_time);
        if (Number.isNaN(at.getTime())) continue;
        if (since && at <= since) continue;
        out.push({ userCode: String(r.user_id).trim(), at, punch: PUNCH[r.state] ?? 'unknown', verifyMode: VERIFY[r.type] });
      }
      return out;
    });
  }

  listUsers() {
    return this.session(async (zk) => {
      const res = await zk.getUsers();
      return ((res?.data ?? []) as Array<{ userId: string; name: string }>).map((u) => ({ userCode: String(u.userId), name: u.name }));
    });
  }

  /**
   * Creates the user record on the terminal. Fingerprint capture itself is done on the terminal's own menu
   * (User Mgt → Edit → Fingerprint), which keeps the template on the device — it never leaves the terminal.
   */
  enrollUser(input: { deviceUserCode: string; name: string }) {
    return this.session(async (zk) => {
      const uid = Number(input.deviceUserCode);
      if (!Number.isInteger(uid) || uid < 1 || uid > 65535) throw new Error('Device user code must be a number from 1 to 65535');
      await zk.setUser(uid, input.deviceUserCode, input.name.slice(0, 24), '', 0, 0);
      return { message: `User ${input.deviceUserCode} created on the terminal. Enrol the fingerprint on the terminal menu: User Mgt → ${input.deviceUserCode} → Fingerprint.` };
    });
  }

  deleteUser(deviceUserCode: string) {
    return this.session(async (zk) => {
      await zk.deleteUser(Number(deviceUserCode));
    });
  }
}
