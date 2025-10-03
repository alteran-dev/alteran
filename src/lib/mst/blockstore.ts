import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';
import type { Env } from '../../env';
import { drizzle } from 'drizzle-orm/d1';
import { blockstore } from '../../db/schema';
import { eq } from 'drizzle-orm';

/**
 * Interface for reading blocks from storage
 */
export interface ReadableBlockstore {
  get(cid: CID): Promise<Uint8Array | null>;
  has(cid: CID): Promise<boolean>;
  getMany(cids: CID[]): Promise<{ blocks: Map<string, Uint8Array>; missing: CID[] }>;
  readObj<T>(cid: CID): Promise<T>;
}

/**
 * Interface for writing blocks to storage
 */
export interface WritableBlockstore extends ReadableBlockstore {
  put(cid: CID, bytes: Uint8Array): Promise<void>;
  putMany(blocks: Map<CID, Uint8Array>): Promise<void>;
}

/**
 * D1-backed blockstore implementation
 */
export class D1Blockstore implements WritableBlockstore {
  constructor(private env: Env) {}

  async get(cid: CID): Promise<Uint8Array | null> {
    const db = drizzle(this.env.DB);
    const result = await db
      .select()
      .from(blockstore)
      .where(eq(blockstore.cid, cid.toString()))
      .get();

    if (!result || !result.bytes) return null;

    // Decode base64 string to Uint8Array
    return Uint8Array.from(atob(result.bytes), c => c.charCodeAt(0));
  }

  async has(cid: CID): Promise<boolean> {
    const db = drizzle(this.env.DB);
    const result = await db
      .select({ cid: blockstore.cid })
      .from(blockstore)
      .where(eq(blockstore.cid, cid.toString()))
      .get();

    return result !== null;
  }

  async getMany(cids: CID[]): Promise<{ blocks: Map<string, Uint8Array>; missing: CID[] }> {
    const blocks = new Map<string, Uint8Array>();
    const missing: CID[] = [];

    for (const cid of cids) {
      const bytes = await this.get(cid);
      if (bytes) {
        blocks.set(cid.toString(), bytes);
      } else {
        missing.push(cid);
      }
    }

    return { blocks, missing };
  }

  async put(cid: CID, bytes: Uint8Array): Promise<void> {
    const db = drizzle(this.env.DB);

    // Encode Uint8Array to base64 string for storage
    const base64 = btoa(String.fromCharCode(...Array.from(bytes)));

    await db
      .insert(blockstore)
      .values({
        cid: cid.toString(),
        bytes: base64,
      })
      .onConflictDoNothing()
      .run();
  }

  async putMany(blocks: Map<CID, Uint8Array>): Promise<void> {
    for (const [cid, bytes] of Array.from(blocks)) {
      await this.put(cid, bytes);
    }
  }

  /**
   * Read and decode a CBOR object from the blockstore
   */
  async readObj<T>(cid: CID): Promise<T> {
    const bytes = await this.get(cid);
    if (!bytes) {
      throw new Error(`Block not found: ${cid.toString()}`);
    }
    return dagCbor.decode(bytes) as T;
  }
}