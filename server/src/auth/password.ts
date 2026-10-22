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

/** PINs are 4–6 digits. Trivial PINs (all the same digit, or a straight run like 1234/9876) are refused. */
export function pinPolicy(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'PIN must be 4 to 6 digits (numbers only)';
  if (/^(\d)\1+$/.test(pin)) return 'PIN cannot be the same digit repeated';
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((v, i) => v - d[i]);
  if (steps.every((x) => x === 1) || steps.every((x) => x === -1)) return 'PIN cannot be a simple sequence like 1234';
  return null;
}
