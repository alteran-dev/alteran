import type { APIContext } from 'astro';
import { verifyResourceRequest, dpopResourceUnauthorized } from '../../lib/oauth/resource';
import { checkRate } from '../../lib/ratelimit';
import { readJsonBounded } from '../../lib/util';
import { RepoManager } from '../../services/repo-manager';
import { notifySequencer } from '../../lib/sequencer';

export const prerender = false;

export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  try {
    const auth = await verifyResourceRequest(env, request);
    if (!auth) return dpopResourceUnauthorized(env);
  } catch (e: any) {
    if (e?.code === 'use_dpop_nonce') return dpopResourceUnauthorized(env);
    return new Response(JSON.stringify({ error: 'AuthRequired' }), { status: 401 });
  }

  const rateLimitResponse = await checkRate(env, request, 'writes');
  if (rateLimitResponse) return rateLimitResponse;

  let body: any;
  try {
    body = await readJsonBounded(env, request);
  } catch (e: any) {
    if (e?.code === 'PayloadTooLarge') {
      return new Response(JSON.stringify({ error: 'PayloadTooLarge' }), { status: 413 });
    }
    return new Response(JSON.stringify({ error: 'BadRequest' }), { status: 400 });
  }
  const { collection, rkey } = body ?? {};
  let { record } = body ?? {};
  if (!collection || !rkey || !record) return new Response(JSON.stringify({ error: 'BadRequest' }), { status: 400 });

  if (collection === 'app.bsky.feed.post' && record && typeof record === 'object') {
    if (typeof record.text !== 'string') {
      record.text = '';
    }
    if (typeof record.createdAt !== 'string') {
      record.createdAt = new Date().toISOString();
    }
  }

  const repo = new RepoManager(env);
  const result = await repo.putRecord(collection, rkey, record);
  await notifySequencer(env, {
    did: env.PDS_DID as string,
    commitCid: result.commitCid,
    rev: result.rev,
    data: result.commitData,
    sig: result.sig,
    ops: result.ops,
    blocks: result.blocks
  });

  const out = {
    uri: result.uri,
    cid: result.cid,
    commit: {
      cid: result.commitCid,
      rev: result.rev,
    },
    validationStatus: 'unknown' as const,
  };

  return new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json' },
  });
}
