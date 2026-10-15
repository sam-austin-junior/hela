import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// The student's app PIN, used to re-authenticate before raising the tier
// or approving a payee. Stored as salt:scrypt-hash.

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function checkPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const given = scryptSync(pin, salt, 32);
  const want = Buffer.from(hash, 'hex');
  return given.length === want.length && timingSafeEqual(given, want);
}
