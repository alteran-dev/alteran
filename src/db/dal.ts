import { getDb } from './client';
import { record, type NewRecordRow, blob_ref, blob_usage, blob_quota } from './schema';
import type { Env } from '../env';
import { eq, inArray, and } from 'drizzle-orm';

export async function putRecord(env: Env, row: NewRecordRow) {
  const db = getDb(env);
  await db.insert(record).values(row).onConflictDoUpdate({ target: record.uri, set: { cid: row.cid, json: row.json } });
}

export async function getRecord(env: Env, uri: string) {
  const db = getDb(env);
  const res = await db.select().from(record).where(eq(record.uri, uri)).get();
  return res ?? null;
}

export async function deleteRecord(env: Env, uri: string) {
  const db = getDb(env);
  await db.delete(record).where(eq(record.uri, uri)).run();
}

export async function listRecords(env: Env) {
  const db = getDb(env);
  return db.select().from(record).all();
}

export async function getRecordsByCids(env: Env, cids: string[]) {
  if (!cids.length) return [] as Awaited<ReturnType<typeof listRecords>>;
  const db = getDb(env);
  return db.select().from(record).where(inArray(record.cid, cids)).all();
}

export async function putBlobRef(env: Env, did: string, cid: string, key: string, mime: string, size: number) {
  const db = getDb(env);
  await db
    .insert(blob_ref)
    .values({ did, cid, key, mime, size })
    .onConflictDoUpdate({ target: blob_ref.cid, set: { did, key, mime, size } });
}

export async function setRecordBlobUsage(env: Env, uri: string, keys: string[]) {
  const db = getDb(env);
  // remove existing usage for this record
  await db.delete(blob_usage).where(eq(blob_usage.recordUri, uri)).run();
  // insert new usage
  for (const key of keys) {
    await db.insert(blob_usage).values({ recordUri: uri, key }).run();
  }
}

export async function listOrphanBlobKeys(env: Env): Promise<string[]> {
  const db = getDb(env);
  // select keys in blob that are not referenced in blob_usage
  const all = await db.select().from(blob_ref).all();
  const used = new Set((await db.select().from(blob_usage).all()).map((u) => u.key));
  return all.map((b) => b.key).filter((k) => !used.has(k));
}

export async function deleteBlobByKey(env: Env, key: string) {
  const db = getDb(env);
  await db.delete(blob_ref).where(eq(blob_ref.key, key)).run();
}

export async function getBlobQuota(env: Env, did: string) {
  const db = getDb(env);
  const quota = await db.select().from(blob_quota).where(eq(blob_quota.did, did)).get();
  return quota ?? { did, total_bytes: 0, blob_count: 0, updated_at: Date.now() };
}

export async function updateBlobQuota(env: Env, did: string, bytesAdded: number, countAdded: number) {
  const db = getDb(env);
  const current = await getBlobQuota(env, did);

  await db
    .insert(blob_quota)
    .values({
      did,
      total_bytes: current.total_bytes + bytesAdded,
      blob_count: current.blob_count + countAdded,
      updated_at: Date.now(),
    })
    .onConflictDoUpdate({
      target: blob_quota.did,
      set: {
        total_bytes: current.total_bytes + bytesAdded,
        blob_count: current.blob_count + countAdded,
        updated_at: Date.now(),
      },
    });
}

export async function checkBlobQuota(env: Env, did: string, additionalBytes: number): Promise<boolean> {
  const quota = await getBlobQuota(env, did);
  const maxBytes = parseInt((env as any).PDS_BLOB_QUOTA_BYTES || '10737418240', 10); // Default: 10GB

  return (quota.total_bytes + additionalBytes) <= maxBytes;
}
