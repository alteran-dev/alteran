import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { buildProfileViewDetailed, getPrimaryActor, matchesPrimaryActor } from '../../lib/actor';
import { countPosts } from '../../lib/feed';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  try {
    return await proxyAppView({
      request,
      env,
      lxm: 'app.bsky.actor.getProfile',
      fallback: async () => {
        console.log('app.bsky.actor.getProfile: Using fallback');
        const url = new URL(request.url);
        const identifier = url.searchParams.get('actor');
        const actor = await getPrimaryActor(env);
        console.log('app.bsky.actor.getProfile: actor', { did: actor.did, handle: actor.handle, identifier });
        if (!matchesPrimaryActor(identifier, actor)) {
          console.log('app.bsky.actor.getProfile: identifier does not match actor');
          return new Response(JSON.stringify({ error: 'ProfileNotFound' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const profile = buildProfileViewDetailed(actor, {
          followers: 0,
          follows: 0,
          posts: await countPosts(env),
        });
        console.log('app.bsky.actor.getProfile: returning profile', profile);
        return new Response(JSON.stringify(profile), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
  } catch (error) {
    console.error('app.bsky.actor.getProfile error:', error);
    return new Response(JSON.stringify({ error: 'InternalServerError', message: String(error) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
