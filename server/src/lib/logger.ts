import pino from 'pino';
import { env } from '../config/env';

/** Keys that must never reach log output. */
export const REDACT_PATHS = [
  'password', '*.password', 'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
  '*.consumerSecret', '*.consumerKey', '*.passkey', '*.SecurityCredential', '*.securityCredential', '*.initiatorPassword', '*.apiKey', '*.smtpPass', '*.pass', '*.token', '*.refreshToken',
  '*.template', '*.biometricTemplate', '*.pin', '*.secret',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { service: 'chili-pos' },
});
