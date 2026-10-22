export interface DeviceInfo {
  id: string;
  vendor: 'zkteco' | 'secugen' | 'mock';
  deviceType: string;
  model?: string;
  connection: 'tcp' | 'udp' | 'usb_bridge' | 'mock';
  host?: string;
  port?: number;
  timezone?: string;
  lastSyncAt?: string;
}

export interface Punch {
  userCode: string;
  at: Date;
  punch: 'clock_in' | 'clock_out' | 'break_start' | 'break_end' | 'unknown';
  verifyMode?: string;
}

/** Each supported device family implements this. Unsupported operations throw a clear error. */
export interface DeviceAdapter {
  test(): Promise<{ ok: true; details: Record<string, unknown>; clockDriftSeconds?: number }>;
  syncTime(): Promise<void>;
  pullAttendance(since?: Date): Promise<Punch[]>;
  listUsers(): Promise<Array<{ userCode: string; name: string }>>;
  enrollUser(input: { deviceUserCode: string; name: string; fingerIndex: number }): Promise<{ message: string }>;
  deleteUser(deviceUserCode: string): Promise<void>;
}
