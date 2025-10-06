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
  if (!collection || !rkey) return new Response(JSON.stringify({ error: 'BadRequest' }), { status: 400 });

  const repo = new RepoManager(env);
  const commit = await repo.deleteRecord(collection, rkey);
  await notifySequencer(env, { 
    did: env.PDS_DID ?? 'did:example:single-user', 
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
