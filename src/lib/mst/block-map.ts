import { CID } from 'multiformats/cid';
import * as uint8arrays from 'uint8arrays';
import * as dagCbor from '@ipld/dag-cbor';
import { cidForCbor } from './util';

/**
 * BlockMap - Efficient storage for IPLD blocks
 * Maps CIDs to their encoded bytes
 */
export class BlockMap implements Iterable<[cid: CID, bytes: Uint8Array]> {
  private map: Map<string, Uint8Array> = new Map();

  constructor(entries?: Iterable<readonly [cid: CID, bytes: Uint8Array]>) {
    if (entries) {
      for (const [cid, bytes] of entries) {
        this.set(cid, bytes);
      }
    }
  }

  /**
   * Add a value to the map (encodes to CBOR and generates CID)
   */
  async add(value: unknown): Promise<CID> {
    const bytes = dagCbor.encode(value);
    const cid = await cidForCbor(value);
    this.set(cid, bytes);
    return cid;
  }

  /**
   * Set a CID->bytes mapping
   */
  set(cid: CID, bytes: Uint8Array): BlockMap {
    this.map.set(cid.toString(), bytes);
    return this;
  }

  /**
   * Get bytes for a CID
   */
  get(cid: CID): Uint8Array | undefined {
    return this.map.get(cid.toString());
  }

  /**
   * Delete a CID from the map
   */
  delete(cid: CID): BlockMap {
    this.map.delete(cid.toString());
    return this;
  }

  /**
   * Get multiple CIDs, returning both found blocks and missing CIDs
   */
  getMany(cids: CID[]): { blocks: BlockMap; missing: CID[] } {
    const missing: CID[] = [];
    const blocks = new BlockMap();
    for (const cid of cids) {
      const got = this.map.get(cid.toString());
      if (got) {
        blocks.set(cid, got);
      } else {
        missing.push(cid);
      }
    }
    return { blocks, missing };
  }

  /**
   * Check if a CID exists in the map
   */
  has(cid: CID): boolean {
    return this.map.has(cid.toString());
  }

  /**
   * Clear all blocks
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Iterate over all blocks
   */
  forEach(cb: (bytes: Uint8Array, cid: CID) => void): void {
    for (const [cid, bytes] of this) {
      cb(bytes, cid);
    }
  }

  /**
   * Get all CIDs
   */
  cids(): CID[] {
    return Array.from(this.keys());
  }

  /**
   * Add all blocks from another BlockMap
   */
  addMap(toAdd: BlockMap): BlockMap {
    for (const [cid, bytes] of toAdd) {
      this.set(cid, bytes);
    }
    return this;
  }

  /**
   * Number of blocks in the map
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Total byte size of all blocks
   */
  get byteSize(): number {
    let size = 0;
    for (const bytes of this.values()) {
      size += bytes.length;
    }
    return size;
  }

  /**
   * Check if two BlockMaps are equal
   */
  equals(other: BlockMap): boolean {
    if (this.size !== other.size) {
      return false;
    }
    for (const [cid, bytes] of this) {
      const otherBytes = other.get(cid);
      if (!otherBytes) return false;
      if (!uint8arrays.equals(bytes, otherBytes)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Iterator for CIDs
   */
  *keys(): Generator<CID, void, unknown> {
    for (const cidStr of this.map.keys()) {
      yield CID.parse(cidStr);
    }
  }

  /**
   * Iterator for bytes
   */
  *values(): Generator<Uint8Array, void, unknown> {
    for (const bytes of this.map.values()) {
      yield bytes;
    }
  }

  /**
   * Iterator for [CID, bytes] entries
   */
  *[Symbol.iterator](): Generator<[CID, Uint8Array], void, unknown> {
    for (const [cidStr, bytes] of this.map.entries()) {
      yield [CID.parse(cidStr), bytes];
    }
  }
}
