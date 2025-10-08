import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { checkRate } from '../../lib/ratelimit';
import { readJsonBounded } from '../../lib/util';
import { RepoManager } from '../../services/repo-manager';
import { bumpRoot } from '../../db/repo';
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
  // Perform the delete in the MST, gather prev/new roots & new blocks
  const { mst, prevMstRoot, uri, newMstBlocks } = await repo.deleteRecord(collection, rkey);

  // Build ops & bump the repo root to create a signed commit
  const currentRoot = await mst.getPointer();
  const opsForCommit = [{ action: 'delete' as const, path: `${collection}/${rkey}`, cid: null }];
  const { commitCid, rev, commitData, sig, blocks } = await bumpRoot(env, prevMstRoot ?? undefined, currentRoot, {
    ops: opsForCommit,
    newMstBlocks: Array.from(newMstBlocks),
  });

  // Notify sequencer with a complete payload matching handleCommitNotification
  await notifySequencer(env, {
    did: env.PDS_DID as string,
    commitCid,
    rev,
    data: commitData,
    sig,
    ops: opsForCommit,
    blocks,
  });

  // Respond with commit info
  return new Response(
    JSON.stringify({ uri, commitCid, rev }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
