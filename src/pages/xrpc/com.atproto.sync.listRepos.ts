import type { APIContext } from 'astro';

export const prerender = false;

/**
 * com.atproto.sync.listRepos
 * List repositories (single-user PDS returns one repo)
 */
export async function GET({ locals, url }: APIContext) {
  const { env } = locals.runtime;

  const did = env.PDS_DID || 'did:example:single-user';
  const handle = env.PDS_HANDLE || 'user.example.com';

  return new Response(
    JSON.stringify({
      repos: [
        {
          did,
          head: '', // TODO: Get from repo_root
          rev: '', // TODO: Get from repo_root
          active: true,
        },
      ],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}