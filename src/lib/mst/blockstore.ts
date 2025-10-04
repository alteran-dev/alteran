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
    const cidStr = cid.toString();

    // Check if block already exists - D1 has issues with ON CONFLICT DO NOTHING
    const existing = await db
      .select({ cid: blockstore.cid })
      .from(blockstore)
      .where(eq(blockstore.cid, cidStr))
      .get();

    if (existing) {
      // Block already exists, skip insert
      return;
    }

    // Encode Uint8Array to base64 string for storage. Chunk to avoid call-stack limits.
    let binary = '';
    const CHUNK_SIZE = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
    }
    const base64 = btoa(binary);

    try {
      await db
        .insert(blockstore)
        .values({
          cid: cidStr,
          bytes: base64,
        })
        .run();
    } catch (error: any) {
      // If we get a unique constraint error, another request inserted it - that's ok
      if (error?.message?.includes('UNIQUE constraint failed') ||
          error?.message?.includes('constraint failed')) {
        return;
      }
      console.error(JSON.stringify({
        level: 'error',
        type: 'blockstore_put',
        cid: cidStr,
        size: bytes.byteLength,
        message: error?.message,
      }));
      throw error;
    }
  }

  async putMany(blocks: Map<CID, Uint8Array>): Promise<void> {
    const db = drizzle(this.env.DB);
    const BATCH_SIZE = 100; // Insert 100 blocks at a time
    const entries = Array.from(blocks.entries());

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const values = [];

      for (const [cid, bytes] of batch) {
        const cidStr = cid.toString();

        // Check if block already exists
        const existing = await db
          .select({ cid: blockstore.cid })
          .from(blockstore)
          .where(eq(blockstore.cid, cidStr))
          .get();

        if (existing) continue;

        // Encode to base64
        let binary = '';
        const CHUNK_SIZE = 0x8000;
        for (let j = 0; j < bytes.length; j += CHUNK_SIZE) {
          binary += String.fromCharCode(...bytes.subarray(j, j + CHUNK_SIZE));
        }
        const base64 = btoa(binary);

        values.push({ cid: cidStr, bytes: base64 });
      }

      if (values.length > 0) {
        try {
          await db.insert(blockstore).values(values).run();
        } catch (error: any) {
          // If batch insert fails, fall back to individual inserts
          for (const value of values) {
            try {
              await db.insert(blockstore).values(value).run();
            } catch (e: any) {
              if (!e?.message?.includes('UNIQUE constraint failed') &&
                  !e?.message?.includes('constraint failed')) {
                console.error(JSON.stringify({
                  level: 'error',
                  type: 'blockstore_put_many',
                  cid: value.cid,
                  message: e?.message,
                }));
              }
            }
          }
        }
      }
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
