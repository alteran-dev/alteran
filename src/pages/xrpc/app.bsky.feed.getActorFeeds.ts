import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

// Implements: app.bsky.feed.getActorFeeds
// Thin proxy to AppView with a safe empty fallback to satisfy clients.
export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.feed.getActorFeeds',
    fallback: async () => {
      // Minimal valid shape per lexicon when upstream unavailable
      return new Response(JSON.stringify({ feeds: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}

