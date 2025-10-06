import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { readJsonBounded } from '../../lib/util';
import { setActorPreferences } from '../../lib/preferences';

export const prerender = false;

export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.actor.putPreferences',
    fallback: async () => {
      let body: any;
      try {
        body = await readJsonBounded(env, request);
      } catch (err: any) {
        if (err?.code === 'PayloadTooLarge') {
          return new Response(JSON.stringify({ error: 'PayloadTooLarge' }), { status: 413 });
        }
        return new Response(JSON.stringify({ error: 'BadRequest' }), { status: 400 });
      }

      const preferences = Array.isArray(body?.preferences) ? body.preferences : [];
      await setActorPreferences(env, preferences);

      return new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}
