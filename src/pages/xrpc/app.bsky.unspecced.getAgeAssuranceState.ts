import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return new Response(
    JSON.stringify({
      status: 'unknown',
      lastInitiatedAt: new Date(0).toISOString(),
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
