import type { APIContext } from 'astro';
import { loadPar, saveCode, deletePar } from '../../lib/oauth/store';

export const prerender = false;

function parseRequestUri(u: string): string | null {
  const p = 'urn:ietf:params:oauth:request_uri:';
  if (!u || !u.startsWith(p)) return null;
  const id = u.slice(p.length);
  return /^[A-Za-z0-9]+$/.test(id) ? id : null;
}

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  const url = new URL(request.url);
  const request_uri = url.searchParams.get('request_uri') || '';
  const client_id = url.searchParams.get('client_id') || '';
  const deny = url.searchParams.get('deny') === '1';
  const prompt = url.searchParams.get('prompt') || '';

  const id = parseRequestUri(request_uri);
  if (!id) {
    return new Response('invalid request_uri', { status: 400 });
  }
  const par = await loadPar(env, id);
  if (!par) {
    return new Response('request expired or not found', { status: 400 });
  }
  if (client_id && client_id !== par.client_id) {
    return new Response('client_id mismatch', { status: 400 });
  }

  if (deny) {
    const redirectDeny = new URL(par.redirect_uri);
    redirectDeny.searchParams.set('state', par.state);
    redirectDeny.searchParams.set('error', 'access_denied');
    return new Response(null, { status: 302, headers: { Location: redirectDeny.toString() } });
  }

  const requireConsent = String((env as any).PDS_REQUIRE_CONSENT ?? '1') !== '0' || prompt === 'consent';
  if (requireConsent && prompt !== 'none') {
    const consentUrl = new URL('/oauth/consent', `${url.protocol}//${url.host}`);
    consentUrl.searchParams.set('request_uri', request_uri);
    consentUrl.searchParams.set('client_id', par.client_id);
    return new Response(null, { status: 302, headers: { Location: consentUrl.toString() } });
  }

  // TODO: implement user authentication + consent UI.
  // For single-user PDS, auto-approve using configured DID.
  const did = String((env as any).PDS_DID ?? 'did:example:single-user');

  // Issue a short-lived authorization code
  const code = crypto.randomUUID().replace(/-/g, '');
  const now = Math.floor(Date.now() / 1000);
  await saveCode(env, code, {
    code,
    client_id: par.client_id,
    redirect_uri: par.redirect_uri,
    code_challenge: par.code_challenge,
    scope: par.scope,
    dpopJkt: par.dpopJkt,
    did,
    createdAt: now,
    expiresAt: now + 600, // 10 minutes
    used: false,
  });
  await deletePar(env, id);

  const redirect = new URL(par.redirect_uri);
  redirect.searchParams.set('state', par.state);
  redirect.searchParams.set('iss', `${url.protocol}//${url.host}`);
  redirect.searchParams.set('code', code);

  return new Response(null, {
    status: 302,
    headers: { Location: redirect.toString() },
  });
}
