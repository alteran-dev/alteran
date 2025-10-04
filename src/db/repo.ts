import type { Env } from '../env';
import { drizzle } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm';
import { repo_root, commit_log } from './schema';
import { RepoManager } from '../services/repo-manager';
import { createCommit, signCommit, commitCid, generateTid, serializeCommit } from '../lib/commit';
import { CID } from 'multiformats/cid';
import { resolveSecret } from '../lib/secrets';

export async function getRoot(env: Env) {
  const db = drizzle(env.DB);
  const did = (await resolveSecret(env.PDS_DID)) ?? 'did:example:single-user';
  return db.select().from(repo_root).where(eq(repo_root.did, did)).get();
}

/**
 * Bump the repository root to a new revision with signed commit
 */
export async function bumpRoot(env: Env, prevMstRoot?: CID): Promise<{
  commitCid: string;
  rev: string;
  ops: import('../lib/firehose/frames').RepoOp[];
  mstRoot: CID;
}> {
  const db = drizzle(env.DB);
  const did = (await resolveSecret(env.PDS_DID)) ?? 'did:example:single-user';

  // Resolve signing key (use ephemeral dev key if not configured and not production)
  const signingKey = await getSigningKey(env);

  // Get current repo state
  const row = await db.select().from(repo_root).where(eq(repo_root.did, did)).get();
  const prevCommitCid = row?.commitCid ? CID.parse(row.commitCid) : null;

  // Get the current MST root
  const repoManager = new RepoManager(env);
  const mst = await repoManager.getOrCreateRoot();
  const mstRootCid = await mst.getPointer();

  // Extract operations if we have a previous MST root
  const ops = prevMstRoot
    ? await repoManager.extractOps(prevMstRoot, mstRootCid)
    : [];

  // Generate new revision (TID)
  const rev = generateTid();

  // Create commit
  const commit = createCommit(did, mstRootCid, rev, prevCommitCid);

  // Sign commit
  const signedCommit = await signCommit(commit, signingKey);

  // Calculate commit CID
  const cid = await commitCid(signedCommit);
  const cidString = cid.toString();

  // Update repo root - use sql.raw with excluded to properly reference INSERT values
  await db
    .insert(repo_root)
    .values({
      did,
      commitCid: cidString,
      rev, // Store TID as text
    })
    .onConflictDoUpdate({
      target: repo_root.did,
      set: {
        commitCid: sql.raw('excluded.commit_cid'),
        rev: sql.raw('excluded.rev'),
      },
    })
    .run();

  // Serialize commit for storage
  const commitBytes = serializeCommit(signedCommit);
  const commitData = JSON.stringify({
    did: signedCommit.did,
    version: signedCommit.version,
    data: signedCommit.data.toString(),
    rev: signedCommit.rev,
    prev: signedCommit.prev?.toString() || null,
  });
  // Encode signature to base64 (workers-safe)
  let s = '';
  for (const b of signedCommit.sig) s += String.fromCharCode(b);
  const sigBase64 = btoa(s);

  // Append to commit log
  await appendCommit(env, cidString, rev, commitData, sigBase64);

  return { commitCid: cidString, rev, ops, mstRoot: mstRootCid };
}

export async function appendCommit(env: Env, cid: string, rev: string, data: string, sig: string) {
  const db = drizzle(env.DB);
  const ts = Date.now();

  await db
    .insert(commit_log)
    .values({
      cid,
      rev,
      data,
      sig,
      ts,
    })
    .run();
}

// Cache for dev-mode ephemeral signing key (in-memory for worker/astro dev)
let cachedDevSigningKey: string | undefined;

async function getSigningKey(env: Env): Promise<string> {
  const configured = await resolveSecret(env.REPO_SIGNING_KEY);
  if (configured && configured.trim() !== '') return configured;

  const envName = (env as any).ENVIRONMENT || 'development';
  if (envName !== 'production') {
    if (cachedDevSigningKey) return cachedDevSigningKey;
    // Generate an ephemeral Ed25519 keypair and cache private key (PKCS#8 base64)
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
      true,
      ['sign', 'verify']
    );
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    let s = '';
    const u8 = new Uint8Array(pkcs8);
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    cachedDevSigningKey = btoa(s);
    return cachedDevSigningKey;
  }

  throw new Error('REPO_SIGNING_KEY not configured');
}
