import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { buildThreadView, getPostByUri } from '../../lib/feed';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.feed.getPostThread',
    fallback: async () => {
      const url = new URL(request.url);
      const uri = url.searchParams.get('uri');
      if (!uri) {
        return new Response(
          JSON.stringify({ error: 'BadRequest', message: 'uri parameter required' }),
          { status: 400 },
        );
      }

      const post = await getPostByUri(env, uri);
      if (!post) {
        return new Response(JSON.stringify({ error: 'NotFound' }), { status: 404 });
      }

      const thread = await buildThreadView(env, post);
      return new Response(JSON.stringify({ thread }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}
