import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.notification.listNotifications',
    fallback: async () =>
      new Response(
        JSON.stringify({
          notifications: [],
          priority: false,
          seenAt: new Date(0).toISOString(),
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  });
}
