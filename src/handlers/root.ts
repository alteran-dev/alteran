import type { APIContext } from 'astro';

export async function GET(_ctx: APIContext) {
  return new Response('Alteran is alive', { status: 200 });
}
