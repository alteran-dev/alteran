import { getDb } from './client';
import { record, type NewRecordRow, blob_ref, blob_usage, blob_quota } from './schema';
import type { Env } from '../env';
import { eq, inArray, and, sql } from 'drizzle-orm';

export async function putRecord(env: Env, row: NewRecordRow) {
  const db = getDb(env);
  await db.insert(record).values(row).onConflictDoUpdate({
    target: record.uri,
    set: {
      cid: sql.raw(`excluded.${record.cid.name}`),
      json: sql.raw(`excluded.${record.json.name}`)
    }
  });
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
    .onConflictDoUpdate({
      target: blob_ref.cid,
      set: {
        did: sql.raw(`excluded.${blob_ref.did.name}`),
        key: sql.raw(`excluded.${blob_ref.key.name}`),
        mime: sql.raw(`excluded.${blob_ref.mime.name}`),
        size: sql.raw(`excluded.${blob_ref.size.name}`)
      }
    });
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

  const newTotalBytes = current.total_bytes + bytesAdded;
  const newBlobCount = current.blob_count + countAdded;
  const now = Date.now();

  await db
    .insert(blob_quota)
    .values({
      did,
      total_bytes: newTotalBytes,
      blob_count: newBlobCount,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: blob_quota.did,
      set: {
        total_bytes: sql.raw(`excluded.${blob_quota.total_bytes.name}`),
        blob_count: sql.raw(`excluded.${blob_quota.blob_count.name}`),
        updated_at: sql.raw(`excluded.${blob_quota.updated_at.name}`),
      },
    });
}

export async function checkBlobQuota(env: Env, did: string, additionalBytes: number): Promise<boolean> {
  const quota = await getBlobQuota(env, did);
  const maxBytes = parseInt((env as any).PDS_BLOB_QUOTA_BYTES || '10737418240', 10); // Default: 10GB

  return (quota.total_bytes + additionalBytes) <= maxBytes;
}

// Account state management for migration support
export async function getAccountState(env: Env, did: string) {
  const db = getDb(env);
  const { account_state } = await import('./schema');
  const state = await db.select().from(account_state).where(eq(account_state.did, did)).get();
  return state ?? null;
}

export async function createAccountState(env: Env, did: string, active: boolean = false) {
  const db = getDb(env);
  const { account_state } = await import('./schema');
  await db.insert(account_state).values({
    did,
    active,
    created_at: Date.now(),
  }).run();
}

export async function setAccountActive(env: Env, did: string, active: boolean) {
  const db = getDb(env);
  const { account_state } = await import('./schema');
  await db.update(account_state)
    .set({ active })
    .where(eq(account_state.did, did))
    .run();
}

export async function isAccountActive(env: Env, did: string): Promise<boolean> {
  const state = await getAccountState(env, did);
  // If no account state exists, assume active (backward compatibility)
  return state?.active ?? true;
}
