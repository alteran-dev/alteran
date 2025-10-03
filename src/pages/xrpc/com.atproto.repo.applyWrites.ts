import type { APIContext } from 'astro';
import { RepoManager } from '@alteran/services/repo-manager';
import { readJson } from '@alteran/lib/util';
import { bumpRoot } from '@alteran/db/repo';

export const prerender = false;

/**
 * com.atproto.repo.applyWrites
 * Apply a batch of repository writes atomically
 */
export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;

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
          uri: `at://${repo}/${collection}/${rkey}`,
          cid: recordCid.toString(),
        });
      } else if ($type === 'com.atproto.repo.applyWrites#update') {
        const { mst, recordCid } = await repoManager.updateRecord(collection, rkey, value);
        results.push({
          uri: `at://${repo}/${collection}/${rkey}`,
          cid: recordCid.toString(),
        });
      } else if ($type === 'com.atproto.repo.applyWrites#delete') {
        await repoManager.deleteRecord(collection, rkey);
        results.push({
          uri: `at://${repo}/${collection}/${rkey}`,
        });
      }
    }

    // Bump repo root to create new commit
    const { commitCid, rev } = await bumpRoot(env);

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
