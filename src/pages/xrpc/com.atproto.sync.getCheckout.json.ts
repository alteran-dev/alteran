import type { APIContext } from 'astro';
import { getRoot as getRepoRoot } from '@alteran/db/repo';
import { listRecords as dalListRecords } from '@alteran/db/dal';
import { tryParse } from '@alteran/lib/util';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  const url = new URL(request.url);
  const did = url.searchParams.get('did') ?? (env.PDS_DID ?? 'did:example:single-user');
  const head = await getRepoRoot(env);
  const rows = await dalListRecords(env);
  const records = rows
    .filter((r) => r.uri.startsWith(`at://${did}/`))
    .map((r) => ({ uri: r.uri, cid: r.cid, value: tryParse(r.json) }));
  return new Response(JSON.stringify({ did, head: head?.commitCid ?? null, rev: head?.rev ?? 0, records }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
