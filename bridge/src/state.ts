import type { DeviceInfo } from './devices/types';

export interface PrinterInfo { _id: string; name: string; role: string; connection: string; host?: string; port?: number; paperWidth?: 58 | 80 }

/** Configuration last received from the API (refreshed on every poll). */
export const state: { printers: PrinterInfo[]; devices: DeviceInfo[]; deviceStatus: Map<string, { status: 'online' | 'offline' | 'error'; error?: string; clockDriftSeconds?: number }>; printerStatus: Map<string, { status: 'ok' | 'error'; error?: string }> } = {
  printers: [],
  devices: [],
  deviceStatus: new Map(),
  printerStatus: new Map(),
};
