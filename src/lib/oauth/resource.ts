import type { Env } from '../../env';
import { verifyAccessToken } from '../session-tokens';
import { decodeProtectedHeader, importJWK, compactVerify, type JWK as JoseJWK } from 'jose';

const NONCE_PDS_KEY = 'oauth_dpop_nonce_pds';

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function urlWithoutHash(u: string): string {
  try { const url = new URL(u); url.hash = ''; return url.toString(); } catch { return u; }
}
// removed local b64urlToBytes and DER helpers; jose handles verification

async function getNonce(env: Env): Promise<string> {
  const { getSecret, setSecret } = await import('../../db/account');
  const now = Math.floor(Date.now() / 1000);
  const raw = await getSecret(env, NONCE_PDS_KEY);
  if (raw) {
    try { const j = JSON.parse(raw) as { v: string, ts: number }; if (now - j.ts < 120) return j.v; } catch {}
  }
  const v = crypto.randomUUID().replace(/-/g, '');
  await setSecret(env, NONCE_PDS_KEY, JSON.stringify({ v, ts: now }));
  return v;
}

export async function verifyResourceRequest(env: Env, request: Request): Promise<{ did: string; token: string } | null> {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('DPoP ')) return null;
  const access = auth.slice(5).trim();

  const dpop = request.headers.get('DPoP');
  const nonce = await getNonce(env);
  if (!dpop) {
    throw { code: 'use_dpop_nonce', nonce };
  }
  const [h,p] = dpop.split('.');
  if (!h||!p) throw { code: 'use_dpop_nonce', nonce };
  const header = decodeProtectedHeader(dpop) as any;
  if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk) throw { code: 'use_dpop_nonce', nonce };
  const method = request.method.toUpperCase();
  const url = urlWithoutHash(request.url);
  const verified = await compactVerify(dpop, await importJWK(header.jwk as JoseJWK, 'ES256'));
  const payload = JSON.parse(new TextDecoder().decode(verified.payload));
  if (payload.htm !== method || payload.htu !== url) throw { code: 'use_dpop_nonce', nonce };
  const now = Math.floor(Date.now()/1000);
  if (typeof payload.iat !== 'number' || now - payload.iat > 300) throw { code: 'use_dpop_nonce', nonce };
  if (!payload.nonce || payload.nonce !== nonce) throw { code: 'use_dpop_nonce', nonce };
  // Verify ath binding
  const enc = new TextEncoder();
  const accessBytes = enc.encode(access);
  const accessBuf = (() => { const b = new ArrayBuffer(accessBytes.byteLength); new Uint8Array(b).set(accessBytes); return b; })();
  const expectedAth = await crypto.subtle.digest('SHA-256', accessBuf);
  const expectedAthB64 = b64url(expectedAth);
  if (payload.ath !== expectedAthB64) throw { code: 'use_dpop_nonce', nonce };
  // Verify signature with JOSE
  const key = await importJWK(header.jwk as JoseJWK, 'ES256');
  // already verified above, nothing else to do

  const payloadJwt = await verifyAccessToken(env, access).catch(() => null);
  if (!payloadJwt) return null;
  return { did: payloadJwt.sub as string, token: access };
}

export async function dpopResourceUnauthorized(env: Env, message?: string): Promise<Response> {
  const nonce = await getNonce(env);
  const headers = new Headers();
  headers.set('WWW-Authenticate', 'DPoP error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof"');
  headers.set('DPoP-Nonce', nonce);
  headers.set('Content-Type', 'application/json');
  const body = JSON.stringify({ error: 'use_dpop_nonce', error_description: message ?? 'DPoP nonce required' });
  return new Response(body, { status: 401, headers });
}

/**
 * Hybrid authentication that supports both DPoP (OAuth) and Bearer (legacy XRPC) tokens.
 * Tries DPoP first, then falls back to Bearer for backward compatibility with official Bluesky apps.
 */
export async function verifyResourceRequestHybrid(env: Env, request: Request): Promise<{ did: string; token: string } | null> {
  const auth = request.headers.get('authorization');
  if (!auth) return null;

  // Try DPoP authentication first (new OAuth flow)
  if (auth.startsWith('DPoP ')) {
    try {
      const result = await verifyResourceRequest(env, request);
      if (result) return result;
    } catch (e: any) {
      // If it's a nonce error, propagate it
      if (e?.code === 'use_dpop_nonce') throw e;
      // Otherwise fall through to Bearer
    }
  }

  // Fall back to Bearer token authentication (legacy XRPC flow)
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    const payloadJwt = await verifyAccessToken(env, token).catch(() => null);
    if (!payloadJwt) return null;
    return { did: payloadJwt.sub as string, token };
  }

  return null;
}
