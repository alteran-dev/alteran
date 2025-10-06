import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import {
  buildProfileViewDetailed,
  getPrimaryActor,
  matchesPrimaryActor,
} from '../../lib/actor';
import { countPosts } from '../../lib/feed';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  // Some clients call with an empty actors list; upstream returns 400.
  // For UX parity, treat missing/empty as an empty result set.
  const url = new URL(request.url);
  const requestedActors = url.searchParams.getAll('actors');
  if (requestedActors.length === 0) {
    return new Response(JSON.stringify({ profiles: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.actor.getProfiles',
    fallback: async () => {
      const actors = requestedActors;
      const actor = await getPrimaryActor(env);
      const posts = await countPosts(env);

      const profiles = actors
        .filter((identifier) => matchesPrimaryActor(identifier, actor))
        .map(() =>
          buildProfileViewDetailed(actor, {
            followers: 0,
            follows: 0,
            posts,
          }),
        );

      return new Response(JSON.stringify({ profiles }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}
