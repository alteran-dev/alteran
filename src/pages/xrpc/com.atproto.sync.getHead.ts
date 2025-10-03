import type { APIContext } from 'astro';
import { getRoot as getRepoRoot } from '@alteran/db/repo';

export const prerender = false;

export async function GET({ locals }: APIContext) {
  const { env } = locals.runtime;
  const root = await getRepoRoot(env);
  if (!root) return new Response(JSON.stringify({ root: null, rev: 0 }), { headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ root: root.commitCid, rev: root.rev }), { headers: { 'Content-Type': 'application/json' } });
}
