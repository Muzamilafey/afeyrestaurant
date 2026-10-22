import crypto from 'node:crypto';
import { env, isProd } from '../config/env';

/**
 * AES-256-GCM encryption for integration secrets (Daraja keys, SMTP passwords, SMS API keys).
 * Ciphertext format: v1:<iv b64>:<tag b64>:<data b64>
 */
function key(): Buffer {
  if (env.SECRETS_ENCRYPTION_KEY) {
    const k = Buffer.from(env.SECRETS_ENCRYPTION_KEY, 'base64');
    if (k.length !== 32) throw new Error('SECRETS_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
    return k;
  }
  if (isProd) throw new Error('SECRETS_ENCRYPTION_KEY is required in production');
  // Deterministic development key so local data survives restarts. Never used in production.
  return crypto.createHash('sha256').update('chili-pos-dev-only-key').digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(payload: string): string {
  const [v, iv, tag, data] = payload.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Show only the last 4 characters of a secret. */
export function maskSecret(s?: string | null): string | null {
  if (!s) return null;
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}
