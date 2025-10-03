import type { APIContext } from 'astro';

export const prerender = false;

/**
 * com.atproto.server.deleteSession
 * Delete the current session (logout)
 */
export async function POST({ locals }: APIContext) {
  const { env } = locals.runtime;

  // TODO: Implement proper session revocation
  // For single-user PDS, we just return success
  // In a full implementation, this would:
  // 1. Extract refresh token from Authorization header
  // 2. Add it to a blacklist/revocation list
  // 3. Invalidate associated access tokens

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}