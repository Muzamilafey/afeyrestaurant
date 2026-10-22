import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config';

/**
 * Local, encrypted store of SecuGen fingerprint templates (ISO 19794-2). Templates never leave this PC:
 * the cloud only receives enrolment status and clock events. AES-256-GCM with TEMPLATE_KEY.
 */
const FILE = path.resolve(process.env.TEMPLATE_FILE ?? 'data/templates.enc');

function key() {
  const k = Buffer.from(config.templateKey, 'base64');
  if (k.length !== 32) throw new Error('TEMPLATE_KEY must be 32 bytes, base64 encoded, to store fingerprint templates');
  return k;
}

type Store = Record<string, { name: string; templates: string[]; enrolledAt: string }>;

export function load(): Store {
  if (!fs.existsSync(FILE)) return {};
  const [iv, tag, data] = fs.readFileSync(FILE, 'utf8').split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
}

export function save(store: Store) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(store), 'utf8'), c.final()]);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, [iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':'), { mode: 0o600 });
}

export function remove(userCode: string) {
  const s = load();
  delete s[userCode];
  save(s);
}
