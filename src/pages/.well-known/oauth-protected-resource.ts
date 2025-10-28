import type { APIContext } from 'astro';
import { withCache, CACHE_CONFIGS } from '../../lib/cache';

export const prerender = false;

export async function GET({ request }: APIContext) {
  return withCache(
    request,
    async () => {
      const url = new URL(request.url);
      const origin = `${url.protocol}//${url.host}`;
      const json = {
        authorization_servers: [origin],
      };
      return new Response(JSON.stringify(json, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
    CACHE_CONFIGS.WELL_KNOWN,
  );
}

