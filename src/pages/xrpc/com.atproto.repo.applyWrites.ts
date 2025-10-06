import type { APIContext } from 'astro';
import { RepoManager } from '../../services/repo-manager';
import { readJson } from '../../lib/util';
import { bumpRoot } from '../../db/repo';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { isAccountActive } from '../../db/dal';
import { checkRate } from '../../lib/ratelimit';
import { notifySequencer } from '../../lib/sequencer';

export const prerender = false;

/**
 * com.atproto.repo.applyWrites
 * Apply a batch of repository writes atomically
 */
export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  // Check if account is active
  const did = env.PDS_DID ?? 'did:example:single-user';
  const active = await isAccountActive(env, did);
  if (!active) {
    return new Response(
      JSON.stringify({
        error: 'AccountDeactivated',
        message: 'Account is deactivated. Activate it before making changes.'
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const rateLimitResponse = await checkRate(env, request, 'writes');
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await readJson(request);
    const { repo, writes, validate = true, swapCommit } = body;

    if (!writes || !Array.isArray(writes)) {
      return new Response(
        JSON.stringify({ error: 'InvalidRequest', message: 'writes must be an array' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const repoManager = new RepoManager(env);
    const results = [];

    // Apply all writes atomically
    for (const write of writes) {
      const { $type, collection, rkey, value } = write;

      if ($type === 'com.atproto.repo.applyWrites#create') {
        const { mst, recordCid } = await repoManager.addRecord(collection, rkey, value);
        results.push({
          $type: 'com.atproto.repo.applyWrites#createResult',
          uri: `at://${repo}/${collection}/${rkey}`,
          cid: recordCid.toString(),
          validationStatus: 'valid',
        });
      } else if ($type === 'com.atproto.repo.applyWrites#update') {
        const { mst, recordCid } = await repoManager.updateRecord(collection, rkey, value);
        results.push({
          $type: 'com.atproto.repo.applyWrites#updateResult',
          uri: `at://${repo}/${collection}/${rkey}`,
          cid: recordCid.toString(),
          validationStatus: 'valid',
        });
      } else if ($type === 'com.atproto.repo.applyWrites#delete') {
        await repoManager.deleteRecord(collection, rkey);
        results.push({
          $type: 'com.atproto.repo.applyWrites#deleteResult',
        });
      }
    }

    // Bump repo root to create new commit
    const { commitCid, rev } = await bumpRoot(env);

    // Notify sequencer about the commit for firehose
    try {
      const commitData = await env.DB.prepare(
        'SELECT data, sig FROM commit_log WHERE cid = ?'
      ).bind(commitCid).first();

      if (commitData) {
        await notifySequencer(env, {
          did: env.PDS_DID ?? 'did:example:single-user',
          commitCid,
          rev,
          data: commitData.data,
          sig: commitData.sig,
          ops: writes.map((w: any) => ({
            action: w.$type?.split('#')[1] || 'create',
            path: `${w.collection}/${w.rkey}`,
            cid: null, // Will be filled by sequencer if needed
          })),
        });
      }
    } catch (err) {
      console.error('Failed to notify sequencer:', err);
      // Don't fail the request if sequencer notification fails
    }

    return new Response(
      JSON.stringify({
        commit: { cid: commitCid, rev },
        results,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('applyWrites error:', error);
    return new Response(
      JSON.stringify({ error: 'InternalServerError', message: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
