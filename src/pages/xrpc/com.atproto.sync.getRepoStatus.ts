import type { APIContext } from 'astro';
import { getRoot as getRepoRoot } from '../../db/repo';
import { isAccountActive, getAccountState } from '../../db/dal';

export const prerender = false;

/**
 * com.atproto.sync.getRepoStatus
 * Mirrors upstream PDS: returns did, active, optional status, and rev if active.
 */
export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  const url = new URL(request.url);
  const did = url.searchParams.get('did') ?? (env.PDS_DID as string);

  try {
    const active = await isAccountActive(env as any, did);
    let status: string | undefined = undefined;
    try {
      const state = await getAccountState(env as any, did);
      // If your schema eventually stores a specific status, map it here.
      // For now, we only expose active=true/false and leave status undefined unless inactive.
      if (state && state.active === false) status = 'desynchronized';
    } catch {}

    let rev: string | undefined;
    if (active) {
      const head = await getRepoRoot(env as any);
      if (head?.rev) rev = String(head.rev);
    }

    return new Response(
      JSON.stringify({ did, active, ...(status ? { status } : {}), ...(rev ? { rev } : {} ) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    const msg = String(error?.message || error);
    if (msg.includes('RepoNotFound')) {
      return new Response(JSON.stringify({ error: 'RepoNotFound', message: msg }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'InternalServerError', message: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

