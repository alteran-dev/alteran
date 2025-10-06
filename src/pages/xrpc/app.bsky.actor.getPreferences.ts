import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { getActorPreferences } from '../../lib/preferences';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.actor.getPreferences',
    fallback: async () => {
      const { preferences } = await getActorPreferences(env);
      return new Response(JSON.stringify({ preferences }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}
