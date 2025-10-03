import type { APIContext } from 'astro';

export const prerender = false;

/**
 * com.atproto.identity.resolveHandle
 * Resolve a handle to a DID
 */
export async function GET({ locals, url }: APIContext) {
  const { env } = locals.runtime;

  const handle = url.searchParams.get('handle');
  const configuredHandle = env.PDS_HANDLE || 'user.example.com';
  const did = env.PDS_DID || 'did:example:single-user';

  if (!handle) {
    return new Response(
      JSON.stringify({ error: 'InvalidRequest', message: 'handle parameter required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Single-user PDS: only resolve if handle matches configured handle
  if (handle === configuredHandle) {
    return new Response(
      JSON.stringify({ did }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response(
    JSON.stringify({ error: 'HandleNotFound' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
}