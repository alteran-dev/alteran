import { randomBytes } from '@noble/hashes/utils.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const SALT_BYTES = 16;
const KEY_LEN = 64;
const SCRYPT_OPTS = {
  N: 1 << 15, // Close to Node scrypt defaults while remaining worker-friendly
  r: 8,
  p: 1,
  dkLen: KEY_LEN,
};

async function derive(password: string, saltHex: string): Promise<string> {
  const salt = hexToBytes(saltHex);
  const key = await scryptAsync(password, salt, SCRYPT_OPTS);
  return bytesToHex(key);
}

export async function hashPassword(password: string): Promise<string> {
  const saltHex = bytesToHex(randomBytes(SALT_BYTES));
  const hashHex = await derive(password, saltHex);
  return `${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const candidate = await derive(password, saltHex);
  return candidate === hashHex;
}

export async function rehashIfNeeded(password: string, stored: string | null): Promise<string | null> {
  if (!stored) return null;
  const [saltHex] = stored.split(':');
  if (!saltHex) return null;
  // Currently no adaptive parameters; placeholder for future upgrades.
  return null;
}
