import { CID } from 'multiformats/cid';
import type { Env } from '../env';
import { MST, D1Blockstore, Leaf, BlockMap } from '../lib/mst';
import { drizzle } from 'drizzle-orm/d1';
import { repo_root, record } from '../db/schema';
import { eq, sql, like } from 'drizzle-orm';
import type { RepoOp } from '../lib/firehose/frames';
import * as dagCbor from '@ipld/dag-cbor';
import { cidForCbor } from '../lib/mst/util';
import { putRecord as dalPutRecord, deleteRecord as dalDeleteRecord } from '../db/dal';
import { bumpRoot } from '../db/repo';
import { generateTid } from '../lib/commit';
import { resolveSecret } from '../lib/secrets';

/**
 * Repository Manager
 * Manages MST-based repository operations
 */
export class RepoManager {
  private blockstore: D1Blockstore;

  constructor(private env: Env) {
    this.blockstore = new D1Blockstore(env);
  }

  private async getDid(): Promise<string> {
    const did = await resolveSecret(this.env.PDS_DID);
    if (!did) throw new Error('PDS_DID is required');
    return did;
  }

  /**
   * Get the current MST root
   */
  async getRoot(): Promise<MST | null> {
    try {
      const db = drizzle(this.env.DB);
      const did = await this.getDid();

      const rows = await db.select()
        .from(repo_root)
        .where(eq(repo_root.did, did))
        .limit(1);

      const row = rows[0];
      if (!row) {
        return null;
      }

      // Get the commit_log entry
      const commit = await this.env.DB.prepare(
        `SELECT data FROM commit_log WHERE cid = ? LIMIT 1`
      ).bind(row.commitCid).first();

      if (!commit) {
        console.error(`[RepoManager] No commit found for CID: ${row.commitCid}`);
        return null;
      }

      const parsed = JSON.parse(String(commit.data));
      const mstRoot = CID.parse(String(parsed.data));

      console.log(`[RepoManager] Loading MST root: ${mstRoot.toString()} from commit: ${row.commitCid}`);

      // Load the MST (blocks should exist from proper storage)
      return MST.load(this.blockstore, mstRoot);

    } catch (e) {
      console.error(`[RepoManager] Error in getRoot:`, e);
      return null;
    }
  }

  /**
   * Get or create the MST root
   */
  async getOrCreateRoot(): Promise<MST> {
    const existing = await this.getRoot();
    if (existing) {
      const pointer = await existing.getPointer();
      console.log(`[RepoManager] Loaded existing MST root: ${pointer.toString()}`);
      return existing;
    }

    // Create new empty MST and immediately store it
    console.log(`[RepoManager] Creating new empty MST`);
    const mst = await MST.create(this.blockstore, []);
    await this.storeMstBlocks(mst);
    const pointer = await mst.getPointer();
    console.log(`[RepoManager] Created new MST root: ${pointer.toString()}`);
    return mst;
  }

  /**
   * Add a record to the repository
   */
  async addRecord(collection: string, rkey: string, record: unknown): Promise<{
    mst: MST;
    recordCid: CID;
    prevMstRoot: CID | null;
    newMstBlocks: BlockMap;
  }> {
    const key = `${collection}/${rkey}`;

    // Get previous MST root for op extraction
    const currentMst = await this.getOrCreateRoot();
    const prevMstRoot = await currentMst.getPointer();

    // Encode record and store in blockstore
    const recordCid = await this.storeRecord(record);

    // Add the new record
    const newMst = await currentMst.add(key, recordCid);

    // Store all new MST blocks
    const newMstBlocks = await this.storeMstBlocks(newMst);

    return { mst: newMst, recordCid, prevMstRoot, newMstBlocks };
  }

  /**
   * High-level helper: create record, persist JSON, bump root, return commit info
   */
  async createRecord(collection: string, record: unknown, rkey?: string): Promise<{
    uri: string;
    cid: string;
    commitCid: string;
    rev: string;
    ops: RepoOp[];
    commitData: string;
    sig: string;
    blocks: string;
  }> {
    const key = rkey ?? generateTid();
    const { mst, recordCid, prevMstRoot } = await this.addRecord(collection, key, record);

    // Persist JSON to table for easy reads
    const did = await this.getDid();
    const uri = `at://${did}/${collection}/${key}`;
    await dalPutRecord(this.env, { uri, did, cid: recordCid.toString(), json: JSON.stringify(record) } as any);

    // Update repo root with signed commit and extract ops
    const { commitCid, rev, ops, commitData, sig, blocks } = await bumpRoot(this.env, prevMstRoot ?? undefined);

    return { uri, cid: recordCid.toString(), commitCid, rev, ops, commitData, sig, blocks };
  }

  /**
   * Update a record in the repository
   */
  async updateRecord(collection: string, rkey: string, record: unknown): Promise<{
    mst: MST;
    recordCid: CID;
    prevMstRoot: CID | null;
    newMstBlocks: BlockMap;
  }> {
    const key = `${collection}/${rkey}`;

    // Get previous MST root for op extraction
    const currentMst = await this.getOrCreateRoot();
    const prevMstRoot = await currentMst.getPointer();

    // Encode record and store in blockstore
    const recordCid = await this.storeRecord(record);

    // Update the record
    const newMst = await currentMst.update(key, recordCid);

    // Store all new MST blocks
    const newMstBlocks = await this.storeMstBlocks(newMst);

    return { mst: newMst, recordCid, prevMstRoot, newMstBlocks };
  }

  /**
   * High-level helper: put record (update), persist JSON, bump root
   */
  async putRecord(collection: string, rkey: string, record: unknown): Promise<{
    uri: string;
    cid: string;
    commitCid: string;
    rev: string;
    ops: RepoOp[];
    commitData: string;
    sig: string;
    blocks: string;
  }> {
    const { mst, recordCid, prevMstRoot } = await this.updateRecord(collection, rkey, record);
    const did = await this.getDid();
    const uri = `at://${did}/${collection}/${rkey}`;
    await dalPutRecord(this.env, { uri, did, cid: recordCid.toString(), json: JSON.stringify(record) } as any);
    const { commitCid, rev, ops, commitData, sig, blocks } = await bumpRoot(this.env, prevMstRoot ?? undefined);
    return { uri, cid: recordCid.toString(), commitCid, rev, ops, commitData, sig, blocks };
  }

  /**
   * Delete a record from the repository
   */
  async deleteRecord(collection: string, rkey: string): Promise<{
    mst: MST;
    prevMstRoot: CID | null;
    uri: string;
    newMstBlocks: BlockMap;
  }> {
    const key = `${collection}/${rkey}`;

    // Get previous MST root for op extraction
    const currentMst = await this.getOrCreateRoot();
    const prevMstRoot = await currentMst.getPointer();

    // Delete the record
    const newMst = await currentMst.delete(key);

    // Store all new MST blocks
    const newMstBlocks = await this.storeMstBlocks(newMst);

    // Delete from records table
    const did = await this.getDid();
    const uri = `at://${did}/${collection}/${rkey}`;
    await dalDeleteRecord(this.env, uri);

    return { mst: newMst, prevMstRoot, uri, newMstBlocks };
  }

  /**
   * Get a record from the repository
   */
  async getRecord(collection: string, rkey: string): Promise<unknown | null> {
    const key = `${collection}/${rkey}`;

    const currentMst = await this.getRoot();
    if (!currentMst) {
      // Fallback: Try reading from record table
      return this.getRecordFromTable(collection, rkey);
    }

    const recordCid = await currentMst.get(key);
    if (!recordCid) {
      // Fallback: Try reading from record table
      return this.getRecordFromTable(collection, rkey);
    }

    return this.blockstore.readObj(recordCid);
  }

  /**
   * Fallback: Get record directly from record table
   */
  private async getRecordFromTable(collection: string, rkey: string): Promise<unknown | null> {
    const did = await this.getDid();
    const uri = `at://${did}/${collection}/${rkey}`;

    const result = await this.env.DB.prepare(
      `SELECT json FROM record WHERE uri = ?`
    ).bind(uri).first();

    if (!result) return null;

    try {
      return JSON.parse(result.json as string);
    } catch {
      return null;
    }
  }

  /**
   * List records in a collection
   */
  async listRecords(collection: string, limit = 50, cursor?: string): Promise<{ key: string; cid: CID }[]> {
    const currentMst = await this.getRoot();
    if (!currentMst) {
      // Fallback: Try reading from record table directly
      return this.listRecordsFromTable(collection, limit, cursor);
    }

    const prefix = `${collection}/`;
    const leaves = await currentMst.listWithPrefix(prefix, limit);

    const results = leaves
      .filter(leaf => !cursor || leaf.key > `${collection}/${cursor}`)
      .map(leaf => ({
        key: leaf.key.replace(prefix, ''),
        cid: leaf.value,
      }));

    // If MST returned nothing, fallback to table
    if (results.length === 0) {
      return this.listRecordsFromTable(collection, limit, cursor);
    }

    return results;
  }

  /**
   * Fallback: List records directly from record table
   */
  private async listRecordsFromTable(collection: string, limit = 50, cursor?: string): Promise<{ key: string; cid: CID }[]> {
    const did = await this.getDid();
    const prefix = `at://${did}/${collection}/`;

    // D1 has issues with LIKE patterns, so we use >= and < with range scan
    // This works because URIs are ordered lexicographically
    const rangeEnd = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

    let stmt;
    if (cursor) {
      stmt = this.env.DB.prepare(
        `SELECT uri, cid FROM record WHERE uri >= ? AND uri < ? AND uri > ? ORDER BY uri LIMIT ?`
      ).bind(prefix, rangeEnd, prefix + cursor, limit);
    } else {
      stmt = this.env.DB.prepare(
        `SELECT uri, cid FROM record WHERE uri >= ? AND uri < ? ORDER BY uri LIMIT ?`
      ).bind(prefix, rangeEnd, limit);
    }

    const result = await stmt.all();
    const rows = result.results as Array<{ uri: string; cid: string }>;

    return rows.map(row => {
      const rkey = row.uri.replace(prefix, '');
      return {
        key: rkey,
        cid: CID.parse(row.cid),
      };
    });
  }

  /**
   * Update the repo root to point to the new MST
   */
  async updateRoot(mst: MST, rev: number): Promise<void> {
    const db = drizzle(this.env.DB);
    const rootCid = await mst.getPointer();
    const did = await this.getDid();
    const revStr = String(rev);

    // Use sql.raw with excluded to properly reference INSERT values
    await db
      .insert(repo_root)
      .values({
        did,
        commitCid: rootCid.toString(),
        rev: revStr,
      })
      .onConflictDoUpdate({
        target: repo_root.did,
        set: {
          commitCid: sql.raw('excluded.commit_cid'),
          rev: sql.raw('excluded.rev'),
        },
      })
      .run();
  }

  /**
   * Extract operations from MST diff between two commits
   * Compares old MST root with new MST root to identify create/update/delete operations
   */
  async extractOps(prevRoot: CID | null, newRoot: CID): Promise<RepoOp[]> {
    const ops: RepoOp[] = [];

    // Load both trees
    const newMst = await MST.load(this.blockstore, newRoot).getEntries();
    const prevMst = prevRoot ? await MST.load(this.blockstore, prevRoot).getEntries() : [];

    // Build maps for efficient lookup
    const prevMap = new Map<string, CID>();
    const newMap = new Map<string, CID>();

    // Collect all leaves from previous tree
    await this.collectLeaves(prevMst, prevMap);

    // Collect all leaves from new tree
    await this.collectLeaves(newMst, newMap);

    // Find creates and updates
    for (const [path, cid] of Array.from(newMap.entries())) {
      const prevCid = prevMap.get(path);
      if (!prevCid) {
        // New key - create operation
        ops.push({
          action: 'create',
          path,
          cid,
        });
      } else if (!prevCid.equals(cid)) {
        // Key exists but CID changed - update operation
        ops.push({
          action: 'update',
          path,
          cid,
          prev: prevCid,
        });
      }
    }

    // Find deletes
    for (const [path, prevCid] of Array.from(prevMap.entries())) {
      if (!newMap.has(path)) {
        // Key no longer exists - delete operation
        ops.push({
          action: 'delete',
          path,
          cid: null,
          prev: prevCid,
        });
      }
    }

    // Sort ops by path for deterministic ordering
    ops.sort((a, b) => a.path.localeCompare(b.path));

    return ops;
  }

  /**
   * Recursively collect all leaves from MST entries into a map
   */
  private async collectLeaves(entries: (MST | Leaf)[], map: Map<string, CID>): Promise<void> {
    for (const entry of entries) {
      if (entry.isLeaf()) {
        map.set(entry.key, entry.value);
      } else {
        // Recursively collect from subtree
        const subEntries = await entry.getEntries();
        await this.collectLeaves(subEntries, map);
      }
    }
  }

  /**
   * Store a record in the blockstore and return its CID
   */
  private async storeRecord(record: unknown): Promise<CID> {
    const bytes = dagCbor.encode(record);
    const cid = await cidForCbor(record);
    await this.blockstore.put(cid, bytes);
    return cid;
  }

  /**
   * Store all blocks from an MST to the blockstore
   * Uses getUnstoredBlocks() to only store new blocks (official PDS approach)
   */
  private async storeMstBlocks(mst: MST): Promise<BlockMap> {
    const diff = await mst.getUnstoredBlocks();

    // Store only the blocks that aren't already in storage
    for (const [cid, bytes] of diff.blocks) {
      console.log(`[RepoManager] Storing new MST block: ${cid.toString()}, size: ${bytes.length}`);
      await this.blockstore.put(cid, bytes);
    }

    console.log(`[RepoManager] Stored ${diff.blocks.size} new MST blocks`);
    return diff.blocks;
  }
}
