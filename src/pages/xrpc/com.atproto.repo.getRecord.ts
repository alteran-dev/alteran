import type { APIContext } from 'astro';
import { getRecord as dalGetRecord } from '@alteran/db/dal';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  const url = new URL(request.url);
  let uri = url.searchParams.get('uri');
  if (!uri) {
    const repo = url.searchParams.get('repo') ?? (env.PDS_DID ?? 'did:example:single-user');
    const collection = url.searchParams.get('collection');
    const rkey = url.searchParams.get('rkey');
    if (repo && collection && rkey) uri = `at://${repo}/${collection}/${rkey}`;
  }

  if (!uri) return new Response(JSON.stringify({ error: 'BadRequest', message: 'query param uri required' }), { status: 400 });

  const row = await dalGetRecord(env, uri);
  if (!row) return new Response(JSON.stringify({ error: 'NotFound' }), { status: 404 });

  return new Response(JSON.stringify({ uri: row.uri, cid: row.cid, value: JSON.parse(row.json) }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
