import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { checkRate } from '../../lib/ratelimit';
import { readJsonBounded } from '../../lib/util';
import { RepoManager } from '../../services/repo-manager';
import { notifySequencer } from '../../lib/sequencer';

export const prerender = false;

export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

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
  const commit = await repo.putRecord(collection, rkey, record);
  await notifySequencer(env, {
    did: env.PDS_DID as string,
    commitCid: commit.commitCid,
    rev: commit.rev,
    data: commit.commitData,
    sig: commit.sig,
    ops: commit.ops,
    blocks: commit.blocks
  });

  return new Response(JSON.stringify(commit), {
    headers: { 'Content-Type': 'application/json' },
  });
}
