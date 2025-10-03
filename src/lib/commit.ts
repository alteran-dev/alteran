import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from 'multiformats/hashes/sha2';

/**
 * AT Protocol Commit Structure
 *
 * A commit represents a snapshot of the repository at a specific revision.
 * It includes:
 * - did: The DID of the repository owner
 * - version: Protocol version (currently 3)
 * - data: CID of the MST root
 * - rev: Revision number (TID format)
 * - prev: CID of the previous commit (null for first commit)
 * - sig: Ed25519 signature over the commit data
 */

export interface CommitData {
  did: string;
  version: number;
  data: CID; // MST root CID
  rev: string; // TID format revision
  prev: CID | null; // Previous commit CID
}

export interface SignedCommit extends CommitData {
  sig: Uint8Array;
}

/**
 * Create a commit object
 */
export function createCommit(
  did: string,
  mstRoot: CID,
  rev: string,
  prev: CID | null = null,
): CommitData {
  return {
    did,
    version: 3,
    data: mstRoot,
    rev,
    prev,
  };
}

/**
 * Sign a commit with Ed25519 private key
 */
export async function signCommit(
  commit: CommitData,
  privateKeyBase64: string,
): Promise<SignedCommit> {
  // Encode commit to CBOR for signing
  const commitBytes = dagCbor.encode(commit);

  // Import private key (PKCS#8 base64)
  const b64 = privateKeyBase64.replace(/\s+/g, '');
  const bin = atob(b64);
  const pkcs8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) pkcs8[i] = bin.charCodeAt(i);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
    false,
    ['sign']
  );

  // Sign the commit bytes
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new Uint8Array(commitBytes as unknown as Uint8Array));

  return {
    ...commit,
    sig: new Uint8Array(signature),
  };
}

/**
 * Verify a signed commit
 */
export async function verifyCommit(
  signedCommit: SignedCommit,
  publicKeyBase64: string,
): Promise<boolean> {
  try {
    // Extract commit data (without signature)
    const { sig, ...commit } = signedCommit;
    const commitBytes = dagCbor.encode(commit);

    // Import public key (SPKI base64)
    const b64 = publicKeyBase64.replace(/\s+/g, '');
    const bin = atob(b64);
    const spki = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) spki[i] = bin.charCodeAt(i);
    const publicKey = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
      false,
      ['verify']
    );

    // Verify signature
    return await crypto.subtle.verify('Ed25519', publicKey, sig as any, new Uint8Array(commitBytes as unknown as Uint8Array));
  } catch (error) {
    console.error('Commit verification failed:', error);
    return false;
  }
}

/**
 * Calculate CID for a signed commit
 */
export async function commitCid(signedCommit: SignedCommit): Promise<CID> {
  const bytes = dagCbor.encode(signedCommit);
  const hash = await sha256.digest(bytes);
  return CID.create(1, dagCbor.code, hash);
}

/**
 * Serialize signed commit to bytes
 */
export function serializeCommit(signedCommit: SignedCommit): Uint8Array {
  return dagCbor.encode(signedCommit);
}

/**
 * Deserialize commit from bytes
 */
export function deserializeCommit(bytes: Uint8Array): SignedCommit {
  return dagCbor.decode(bytes) as SignedCommit;
}

/**
 * Generate a TID (Timestamp Identifier) for use as revision
 * TIDs are lexicographically sortable timestamps
 */
export function generateTid(): string {
  const now = Date.now();
  const timestamp = now * 1000; // microseconds

  // Convert to base32 (simplified version)
  const chars = '234567abcdefghijklmnopqrstuvwxyz';
  let tid = '';
  let remaining = timestamp;

  for (let i = 0; i < 13; i++) {
    tid = chars[remaining % 32] + tid;
    remaining = Math.floor(remaining / 32);
  }

  return tid;
}

/**
 * Validate TID format
 */
export function isValidTid(tid: string): boolean {
  return /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/.test(tid);
}
