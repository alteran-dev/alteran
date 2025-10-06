import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { buildPostViews, getPostsByUris } from '../../lib/feed';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.feed.getPosts',
    fallback: async () => {
      const url = new URL(request.url);
      const uris = url.searchParams.getAll('uris').filter(Boolean);
      const posts = await getPostsByUris(env, uris.slice(0, 25));
      const views = await buildPostViews(env, posts);
      return new Response(JSON.stringify({ posts: views }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}
