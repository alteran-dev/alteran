import type { Env } from '../env';
import { listRecords } from '../db/dal';
import { drizzle } from 'drizzle-orm/d1';
import { desc, and, gte, lte } from 'drizzle-orm';
import { commit_log } from '../db/schema';
import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from 'multiformats/hashes/sha2';
import { MST, Leaf, D1Blockstore } from '../lib/mst';

export type CarSnapshot = {
  bytes: Uint8Array;
  root: CID;
  blocks: { cid: CID; bytes: Uint8Array }[];
};

export async function encodeRecordBlock(value: unknown) {
  const bytes = dagCbor.encode(value);
  const hash = await sha256.digest(bytes);
  const cid = CID.createV1(dagCbor.code, hash);
  return { cid, bytes } as const;
}

export async function buildRepoCar(env: Env, did: string): Promise<CarSnapshot> {
  // Prefer the latest signed commit from commit_log (authoritative root)
  const db = drizzle(env.DB);
  const tip = await db.select().from(commit_log).orderBy(desc(commit_log.seq)).limit(1).get();

  if (tip) {
    try {
      // Reconstruct the exact signed commit object that produced tip.cid
      const parsed = JSON.parse(tip.data);
      const prevStr = parsed.prev ?? null;
      const signedCommit = {
        did: parsed.did as string,
        version: parsed.version as number,
        data: CID.parse(String(parsed.data)),
        rev: String(parsed.rev),
        prev: prevStr ? CID.parse(String(prevStr)) : null,
        sig: (() => {
          const bin = atob(String(tip.sig));
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return u8;
        })(),
      } as const;

      // Encode to CBOR and verify CID matches tip
      const commitBytes = dagCbor.encode(signedCommit);
      const hash = await sha256.digest(commitBytes);
      const commitCid = CID.createV1(dagCbor.code, hash);

      if (commitCid.toString() === (tip as any).cid) {
        // Build a full snapshot CAR: commit block + all MST nodes + all record blocks
        const blockstore = new D1Blockstore(env);
        const blocks: { cid: CID; bytes: Uint8Array }[] = [{ cid: commitCid, bytes: commitBytes }];
        const seen = new Set<string>([commitCid.toString()]);

        const addBlock = async (cid: CID) => {
          const key = cid.toString();
          if (seen.has(key)) return;
          const bytes = await blockstore.get(cid);
          if (bytes) {
            seen.add(key);
            blocks.push({ cid, bytes });
          }
        };

        const mstRoot = CID.parse(String(parsed.data));
        // 1) Add all MST node blocks
        await addMstBlocks(blockstore, mstRoot, seen, blocks);

        // 2) Add all record leaf blocks by walking the MST
        try {
          const mst = MST.load(blockstore, mstRoot);
          for await (const leaf of mst.walkLeavesFrom('')) {
            await addBlock(leaf.value);
          }
        } catch (e) {
          console.warn('Snapshot: failed traversing MST leaves:', e);
        }

        const bytes = encodeCar([commitCid], blocks);
        return { bytes, root: commitCid, blocks };
      }
    } catch (e) {
      // Fall through to deterministic snapshot
      console.warn('Failed to reconstruct signed commit from tip; falling back to snapshot:', e);
    }
  }

  // Fallback: deterministic snapshot built from current records
  const rows = await listRecords(env);
  const blocks: { cid: CID; bytes: Uint8Array }[] = [];
  for (const r of rows) {
    if (!r.uri.startsWith(`at://${did}/`)) continue;
    const value = JSON.parse(r.json);
    const block = await encodeRecordBlock(value);
    blocks.push(block);
  }
  const commitObj = { type: 'commit', did, records: blocks.map((b) => b.cid.toString()).sort() };
  const commit = await encodeRecordBlock(commitObj);
  const bytes = encodeCar([commit.cid], [...blocks, commit]);
  return { bytes, root: commit.cid, blocks: [...blocks, commit] };
}

export async function buildRepoCarRange(env: Env, fromSeq: number, toSeq: number): Promise<CarSnapshot> {
  const db = drizzle(env.DB);
  const rows = await db.select().from(commit_log).where(and(gte(commit_log.seq, fromSeq), lte(commit_log.seq, toSeq))).all();
  const blocks: { cid: CID; bytes: Uint8Array }[] = [];
  for (const r of rows) {
    const b = await encodeRecordBlock({ type: 'commit', rev: r.rev, head: r.cid, ts: r.ts });
    blocks.push(b);
  }
  const root = blocks[blocks.length - 1]?.cid ?? (await encodeRecordBlock({})).cid;
  const bytes = encodeCar([root], blocks);
  return { bytes, root, blocks };
}

export async function buildBlocksCar(values: unknown[]): Promise<CarSnapshot> {
  const blocks: { cid: CID; bytes: Uint8Array }[] = [];
  for (const v of values) {
    const block = await encodeRecordBlock(v);
    blocks.push(block);
  }
  const root = blocks[0]?.cid ?? (await encodeRecordBlock({})).cid;
  const bytes = encodeCar([root], blocks);
  return { bytes, root, blocks };
}

/**
 * Encode a list of already-encoded blocks into a CAR v1 file.
 */
export function encodeBlocksToCAR(root: CID, blocks: { cid: CID; bytes: Uint8Array }[]): Uint8Array {
  return encodeCar([root], blocks);
}

export function encodeExistingBlocksToCAR(roots: CID[], blocks: { cid: CID; bytes: Uint8Array }[]): Uint8Array {
  return encodeCar(roots, blocks);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.byteLength, 0);
  const buf = new Uint8Array(size);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.byteLength; }
  return buf;
}

function varint(n: number): Uint8Array {
  const bytes: number[] = [];
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return new Uint8Array(bytes);
}

function encodeCar(roots: CID[], blocks: { cid: CID; bytes: Uint8Array }[]): Uint8Array {
  const header = dagCbor.encode({ version: 1, roots });
  const chunks: Uint8Array[] = [];
  chunks.push(varint(header.byteLength));
  chunks.push(header);
  for (const { cid, bytes } of blocks) {
    const block = concat([cid.bytes, bytes]);
    chunks.push(varint(block.byteLength));
    chunks.push(block);
  }
  return concat(chunks);
}

/**
 * Encode blocks for firehose commit frame
 * Includes commit block, MST nodes, and record blocks
 */
export async function encodeBlocksForCommit(
  env: Env,
  commitCid: CID,
  mstRoot: CID,
  ops: Array<{ path: string; cid: CID | null }>,
): Promise<Uint8Array> {
  const blockstore = new D1Blockstore(env);
  const blocks: { cid: CID; bytes: Uint8Array }[] = [];
  const seen = new Set<string>();

  // Helper to add block if not already seen
  const addBlock = async (cid: CID) => {
    const cidStr = cid.toString();
    if (seen.has(cidStr)) return;
    seen.add(cidStr);

    const bytes = await blockstore.get(cid);
    if (bytes) {
      blocks.push({ cid, bytes });
    }
  };

  // 1. Add commit block
  await addBlock(commitCid);

  // 2. Add MST nodes by traversing the tree
  await addMstBlocks(blockstore, mstRoot, seen, blocks);

  // 3. Add record blocks for all operations
  for (const op of ops) {
    if (op.cid) {
      await addBlock(op.cid);
    }
  }

  // Encode as CAR with commit as root
  return encodeCar([commitCid], blocks);
}

/**
 * Recursively add all MST node blocks
 */
async function addMstBlocks(
  blockstore: D1Blockstore,
  rootCid: CID,
  seen: Set<string>,
  blocks: { cid: CID; bytes: Uint8Array }[],
): Promise<void> {
  const cidStr = rootCid.toString();
  if (seen.has(cidStr)) return;
  seen.add(cidStr);

  // Add the MST node block itself
  const bytes = await blockstore.get(rootCid);
  if (!bytes) return;
  blocks.push({ cid: rootCid, bytes });

  // Load MST and traverse children
  try {
    const mst = MST.load(blockstore, rootCid);
    const entries = await mst.getEntries();

    for (const entry of entries) {
      if (entry.isTree()) {
        // Recursively add child MST blocks
        const childCid = await entry.getPointer();
        await addMstBlocks(blockstore, childCid, seen, blocks);
      }
    }
  } catch (error) {
    console.error('Error traversing MST:', error);
  }
}
