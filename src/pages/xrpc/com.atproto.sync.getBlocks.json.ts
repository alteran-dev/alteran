import type { APIContext } from 'astro';
import { getRecordsByCids as dalGetByCids } from '@alteran/db/dal';
import { tryParse } from '@alteran/lib/util';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  const url = new URL(request.url);
  const cids = (url.searchParams.get('cids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = await dalGetByCids(env, cids);
  const blocks = rows.map((r) => ({ cid: r.cid, value: tryParse(r.json) }));
  return new Response(JSON.stringify({ blocks }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
