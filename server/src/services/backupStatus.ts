import fs from 'node:fs';
import path from 'node:path';

/** Reads the status file written by scripts/backup.sh. */
export async function getBackupStatus() {
  const file = process.env.BACKUP_STATUS_FILE || path.resolve('backups/last-backup.json');
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as { at: string; ok: boolean; file?: string; sizeBytes?: number; error?: string };
  } catch {
    return { at: null, ok: false, error: 'No backup has been recorded on this server' };
  }
}
