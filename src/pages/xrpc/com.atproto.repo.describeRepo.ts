import type { APIContext } from 'astro';
import { getRoot } from '@alteran/db/repo';

export const prerender = false;

/**
 * com.atproto.repo.describeRepo
 * Get metadata about a repository
 */
export async function GET({ locals, url }: APIContext) {
  const { env } = locals.runtime;

  const repo = url.searchParams.get('repo') || env.PDS_DID || 'did:example:single-user';
  const did = env.PDS_DID || 'did:example:single-user';
  const handle = env.PDS_HANDLE || 'user.example.com';

  // Get repo root to check if repo exists
  const root = await getRoot(env);

  return new Response(
    JSON.stringify({
      did,
      handle,
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
      collections: [
        'app.bsky.feed.post',
        'app.bsky.feed.like',
        'app.bsky.feed.repost',
        'app.bsky.graph.follow',
        'app.bsky.actor.profile',
      ],
      handleIsCorrect: true,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
