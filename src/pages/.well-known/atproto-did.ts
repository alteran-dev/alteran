import type { APIContext } from 'astro';

export const prerender = false;

export function GET({ locals }: APIContext) {
  return new Response(locals.runtime.env.PDS_DID ?? '');
}