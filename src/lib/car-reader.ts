/**
 * CAR (Content Addressable aRchive) Reader
 * Implements CAR v1 spec: https://ipld.io/specs/transport/car/carv1/
 */

import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';

export interface CarHeader {
  version: 1;
  roots: CID[];
}

export interface CarBlock {
  cid: CID;
  bytes: Uint8Array;
}

/**
 * Read varint from buffer
 * Returns [value, bytesRead]
 */
function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset + bytesRead < bytes.length) {
    const byte = bytes[offset + bytesRead];
    bytesRead++;

    value |= (byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return [value, bytesRead];
    }

    shift += 7;
  }

  throw new Error('Invalid varint: unexpected end of buffer');
}

/**
 * Parse CAR header from bytes
 */
export function parseCarHeader(bytes: Uint8Array): { header: CarHeader; offset: number } {
  // Read header length
  const [headerLength, headerLengthBytes] = readVarint(bytes, 0);

  // Extract header bytes
  const headerStart = headerLengthBytes;
  const headerEnd = headerStart + headerLength;
  const headerBytes = bytes.slice(headerStart, headerEnd);

  // Decode header
  const decoded = dagCbor.decode(headerBytes) as any;

  if (decoded.version !== 1) {
    throw new Error(`Unsupported CAR version: ${decoded.version}`);
  }

  // Roots are already CID objects from dag-cbor decode
  const roots = (decoded.roots || []).map((r: any) => {
    if (r instanceof Uint8Array) {
      return CID.decode(r);
    }
    return r; // Already a CID
  });

  return {
    header: { version: 1, roots },
    offset: headerEnd,
  };
}

/**
 * Parse a single block from CAR bytes
 * Returns the block and the new offset, or null if no more blocks
 */
export function parseCarBlock(bytes: Uint8Array, offset: number): { block: CarBlock; offset: number } | null {
  if (offset >= bytes.length) {
    return null;
  }

  // Read block length
  const [blockLength, blockLengthBytes] = readVarint(bytes, offset);
  offset += blockLengthBytes;

  if (offset + blockLength > bytes.length) {
    throw new Error('Invalid CAR: block extends beyond buffer');
  }

  // Extract block bytes
  const blockBytes = bytes.slice(offset, offset + blockLength);
  offset += blockLength;

  // Parse CID (first part of block) using decodeFirst to get remainder
  const [cid, remainder] = CID.decodeFirst(blockBytes);

  // Extract data (rest of block is the remainder)
  const data = remainder;

  return {
    block: { cid, bytes: data },
    offset,
  };
}

/**
 * Parse entire CAR file
 */
export function parseCarFile(bytes: Uint8Array): { header: CarHeader; blocks: CarBlock[] } {
  const { header, offset: initialOffset } = parseCarHeader(bytes);
  const blocks: CarBlock[] = [];

  let offset = initialOffset;
  while (offset < bytes.length) {
    const result = parseCarBlock(bytes, offset);
    if (!result) break;

    blocks.push(result.block);
    offset = result.offset;
  }

  return { header, blocks };
}

/**
 * Validate that block CID matches content
 */
export async function validateBlock(block: CarBlock): Promise<boolean> {
  try {
    const decoded = dagCbor.decode(block.bytes);
    const reencoded = dagCbor.encode(decoded);

    // Verify bytes match
    if (reencoded.length !== block.bytes.length) {
      return false;
    }

    for (let i = 0; i < reencoded.length; i++) {
      if (reencoded[i] !== block.bytes[i]) {
        return false;
      }
    }

    // Verify CID matches
    const { sha256 } = await import('multiformats/hashes/sha2');
    const hash = await sha256.digest(block.bytes);
    const expectedCid = CID.createV1(dagCbor.code, hash);

    return block.cid.equals(expectedCid);
  } catch {
    return false;
  }
}