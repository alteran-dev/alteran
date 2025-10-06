import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { buildProfileViewDetailed, getPrimaryActor, matchesPrimaryActor } from '../../lib/actor';
import { countPosts } from '../../lib/feed';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.actor.getProfile',
    fallback: async () => {
      const url = new URL(request.url);
      const identifier = url.searchParams.get('actor');
      const actor = await getPrimaryActor(env);
      if (!matchesPrimaryActor(identifier, actor)) {
        return new Response(JSON.stringify({ error: 'ProfileNotFound' }), { status: 404 });
      }
      const profile = buildProfileViewDetailed(actor, {
        followers: 0,
        follows: 0,
        posts: await countPosts(env),
      });
      return new Response(JSON.stringify(profile), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}
