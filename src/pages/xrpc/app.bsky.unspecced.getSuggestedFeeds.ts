import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

// Implements: app.bsky.unspecced.getSuggestedFeeds (proxy-only)
export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.unspecced.getSuggestedFeeds',
    fallback: async () => {
      return new Response(JSON.stringify({ feeds: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}

