import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { buildProfileView, getPrimaryActor, matchesPrimaryActor } from '../../lib/actor';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.graph.getFollows',
    fallback: async () => {
      const url = new URL(request.url);
      const identifier = url.searchParams.get('actor');
      const actor = await getPrimaryActor(env);
      if (!matchesPrimaryActor(identifier, actor)) {
        return new Response(JSON.stringify({ error: 'ActorNotFound' }), { status: 404 });
      }
      return new Response(
        JSON.stringify({ subject: buildProfileView(actor), follows: [] }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
}
