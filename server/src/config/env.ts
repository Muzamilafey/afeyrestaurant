import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/chili_pos?replicaSet=rs0'),
  /** Public base URL of the API, used to build provider callback URLs (e.g. https://api.chilipos.co.ke). */
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  /** Root domain used for tenant subdomains, e.g. chilipos.co.ke → mama-oliech.chilipos.co.ke */
  ROOT_DOMAIN: z.string().default('localhost'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  JWT_ACCESS_SECRET: z.string().min(32).default('dev-access-secret-change-me-dev-access-secret'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  /** 32-byte key (base64) used for AES-256-GCM encryption of integration secrets at rest. */
  SECRETS_ENCRYPTION_KEY: z.string().default(''),
  COOKIE_SECURE: bool.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Allow mock providers (M-Pesa/SMS/Email/devices). Always refused in production. */
  ALLOW_MOCK_PROVIDERS: bool.default(true),
  RUN_WORKER_IN_PROCESS: bool.default(true),
  UPLOAD_DIR: z.string().default('uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(5),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  /** Optional comma-separated list of IPs permitted to call M-Pesa callback endpoints. Empty = no IP restriction. */
  MPESA_CALLBACK_IP_ALLOWLIST: z.string().default(''),
  TRUST_PROXY: z.string().default('loopback'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

if (isProd) {
  const problems: string[] = [];
  if (env.JWT_ACCESS_SECRET.startsWith('dev-')) problems.push('JWT_ACCESS_SECRET must be set');
  if (!env.SECRETS_ENCRYPTION_KEY) problems.push('SECRETS_ENCRYPTION_KEY must be set');
  if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true behind HTTPS');
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error('Refusing to start in production:', problems.join('; '));
    process.exit(1);
  }
}

export const mocksAllowed = !isProd && env.ALLOW_MOCK_PROVIDERS;
