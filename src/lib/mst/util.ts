import { CID } from 'multiformats/cid';
import * as uint8arrays from 'uint8arrays';
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from 'multiformats/hashes/sha2';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

/**
 * Calculate leading zeros in the hash of a key
 * Used to determine which layer of the MST a key belongs to
 * ~4 fanout (2 bits of zero per layer)
 */
export async function leadingZerosOnHash(key: string | Uint8Array): Promise<number> {
  const bytes = typeof key === 'string' ? uint8arrays.fromString(key, 'utf8') : key;
  const hash = nobleSha256(bytes);

  let leadingZeros = 0;
  for (let i = 0; i < hash.length; i++) {
    const byte = hash[i];
    if (byte < 64) leadingZeros++;
    if (byte < 16) leadingZeros++;
    if (byte < 4) leadingZeros++;
    if (byte === 0) {
      leadingZeros++;
    } else {
      break;
    }
  }
  return leadingZeros;
}

/**
 * Count common prefix length between two strings
 */
export function countPrefixLen(a: string, b: string): number {
  let i;
  for (i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      break;
    }
  }
  return i;
}

/**
 * Validate MST key format
 * Keys must be in format: collection/rkey
 * Max length 1024, valid chars only
 */
export function isValidMstKey(str: string): boolean {
  const split = str.split('/');
  return (
    str.length <= 1024 &&
    split.length === 2 &&
    split[0].length > 0 &&
    split[1].length > 0 &&
    isValidChars(split[0]) &&
    isValidChars(split[1])
  );
}

const validCharsRegex = /^[a-zA-Z0-9_~\-:.]*$/;

export function isValidChars(str: string): boolean {
  return validCharsRegex.test(str);
}

export function ensureValidMstKey(str: string): void {
  if (!isValidMstKey(str)) {
    throw new InvalidMstKeyError(str);
  }
}

export class InvalidMstKeyError extends Error {
  constructor(public key: string) {
    super(`Not a valid MST key: ${key}`);
  }
}

/**
 * Calculate CID for CBOR data
 */
export async function cidForCbor(data: unknown): Promise<CID> {
  const bytes = dagCbor.encode(data);
  const hash = await sha256.digest(bytes);
  return CID.create(1, dagCbor.code, hash);
}
