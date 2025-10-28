import type { APIContext } from 'astro';
import { withCache, CACHE_CONFIGS } from '../../lib/cache';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  return withCache(
    request,
    async () => {
      const url = new URL(request.url);
      const origin = `${url.protocol}//${url.host}`;
      const json = {
        issuer: origin,
        pushed_authorization_request_endpoint: `${origin}/oauth/par`,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        scopes_supported: 'atproto transition:generic',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
        dpop_signing_alg_values_supported: ['ES256'],
      };
      return new Response(JSON.stringify(json, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
    CACHE_CONFIGS.WELL_KNOWN,
  );
}
