import type { Env } from '../../env';
import { verifyAccessToken } from '../session-tokens';

const NONCE_PDS_KEY = 'oauth_dpop_nonce_pds';

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function urlWithoutHash(u: string): string {
  try { const url = new URL(u); url.hash = ''; return url.toString(); } catch { return u; }
}

function jwsEs256ToDer(sig: Uint8Array): Uint8Array {
  function trim(bytes: Uint8Array): Uint8Array { let i=0; while(i<bytes.length-1&&bytes[i]===0)i++; let v=bytes.slice(i); if(v[0]&0x80){const out=new Uint8Array(v.length+1); out[0]=0; out.set(v,1); return out;} return v; }
  const r = trim(sig.slice(0,32));
  const s = trim(sig.slice(32));
  const totalLen = 2 + r.length + 2 + s.length;
  const der = new Uint8Array(2 + 1 + totalLen);
  let o=0; der[o++]=0x30; der[o++]=0x81; der[o++]=totalLen; der[o++]=0x02; der[o++]=r.length; der.set(r,o); o+=r.length; der[o++]=0x02; der[o++]=s.length; der.set(s,o); return der;
}

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
  const [h,p,s] = dpop.split('.');
  if (!h||!p||!s) throw { code: 'use_dpop_nonce', nonce };
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk) throw { code: 'use_dpop_nonce', nonce };
  const method = request.method.toUpperCase();
  const url = urlWithoutHash(request.url);
  if (payload.htm !== method || payload.htu !== url) throw { code: 'use_dpop_nonce', nonce };
  const now = Math.floor(Date.now()/1000);
  if (typeof payload.iat !== 'number' || now - payload.iat > 300) throw { code: 'use_dpop_nonce', nonce };
  if (!payload.nonce || payload.nonce !== nonce) throw { code: 'use_dpop_nonce', nonce };
  // Verify ath binding
  const expectedAth = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(access));
  const expectedAthB64 = b64url(expectedAth);
  if (payload.ath !== expectedAthB64) throw { code: 'use_dpop_nonce', nonce };
  // Verify signature
  const key = await crypto.subtle.importKey('jwk', header.jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const sig = b64urlToBytes(s);
  if (sig.length !== 64) throw { code: 'use_dpop_nonce', nonce };
  const der = jwsEs256ToDer(sig);
  const ok = await crypto.subtle.verify('ECDSA', key, der, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw { code: 'use_dpop_nonce', nonce };

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

