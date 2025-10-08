import type { APIContext } from 'astro';

export const prerender = false;

/**
 * com.atproto.server.getSession
 * Get information about the current session
 */
export async function GET({ locals }: APIContext) {
  const { env } = locals.runtime;

  // TODO: Implement proper session validation from Authorization header
  // For now, return basic session info for single-user PDS

  const did = env.PDS_DID as string;
  const handle = env.PDS_HANDLE ?? 'user.example.com';

  return new Response(
    JSON.stringify({
      did,
      handle,
      email: 'user@example.com', // Single-user PDS doesn't have email
      emailConfirmed: true,
      emailAuthFactor: false,
      didDoc: {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: did,
        alsoKnownAs: [`at://${handle}`],
        verificationMethod: [],
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: `https://${handle}`,
          },
        ],
      },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
};
