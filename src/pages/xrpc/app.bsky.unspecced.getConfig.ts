import type { APIContext } from 'astro';

export const prerender = false;

export async function GET() {
  return new Response(
    JSON.stringify({
      checkEmailConfirmed: false,
      liveNow: [],
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
