import argon2 from 'argon2';

// OWASP-recommended Argon2id parameters (m=19MiB, t=2, p=1).
const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string) => argon2.hash(plain, OPTS);
export async function verifyPassword(hash: string | undefined | null, plain: string) {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
/** Pre-computed hash used to keep timing uniform when a user does not exist. */
let dummy: string | null = null;
export async function dummyVerify(plain: string) {
  dummy ??= await hashPassword('timing-equaliser');
  await verifyPassword(dummy, plain);
  return false;
}

export function passwordPolicy(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain upper and lower case letters and a number';
  return null;
}
