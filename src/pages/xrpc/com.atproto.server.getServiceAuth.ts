import type { APIContext } from 'astro';
import { authenticateRequest, unauthorized } from '../../lib/auth';
import { createServiceAuthToken } from '../../lib/appview';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  const url = new URL(request.url);
  const audienceParam = url.searchParams.get('aud');
  const lexParam = url.searchParams.get('lxm');
  const expParam = url.searchParams.get('exp');

  const audience = audienceParam?.trim();
  if (!audience) {
    return new Response(JSON.stringify({ error: 'MissingAudience' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const lexiconMethod = lexParam && lexParam.trim() !== '' ? lexParam.trim() : null;

  let expiresIn = 60;
  const now = Math.floor(Date.now() / 1000);
  if (expParam !== null) {
    if (!/^-?\d+$/.test(expParam)) {
      return new Response(JSON.stringify({ error: 'BadExpiration', message: 'expiration must be an integer timestamp' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const exp = Number(expParam);
    if (exp <= now) {
      return new Response(JSON.stringify({ error: 'BadExpiration', message: 'expiration is in the past' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (exp - now > 3600) {
      return new Response(JSON.stringify({ error: 'BadExpiration', message: 'expiration too far in future' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    expiresIn = Math.max(1, exp - now);
  }

  try {
    const token = await createServiceAuthToken(env, auth.claims.sub, audience, lexiconMethod, expiresIn);
    return new Response(JSON.stringify({ token }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('service auth error:', error);
    return new Response(JSON.stringify({ error: 'InternalServerError' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
