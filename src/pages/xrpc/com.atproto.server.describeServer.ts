import type { APIContext } from 'astro';

export const prerender = false;

export function GET({ locals }: APIContext) {
  const { env } = locals.runtime;
  const body = {
    version: 'experimental',
    did: env.PDS_DID ?? null,
    handle: env.PDS_HANDLE ?? null,
    inviteCodeRequired: false,
    links: {},
  };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}
