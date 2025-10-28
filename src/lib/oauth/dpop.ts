import type { Env } from '../../env';
import { getOrCreateSecret, setSecret, getSecret } from '../../db/account';

// DPoP nonce management and proof verification utilities

const NONCE_AUTHZ_KEY = 'oauth_dpop_nonce_authz';
const NONCE_TTL_SEC = 120; // rotate roughly every 2 minutes

export interface DpopVerification {
  jkt: string; // JWK thumbprint
  jwk: JsonWebKey;
  payload: any;
}

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

export async function getAuthzNonce(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const existingRaw = await getSecret(env, NONCE_AUTHZ_KEY);
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as { v: string; ts: number };
      if (typeof parsed.v === 'string' && typeof parsed.ts === 'number') {
        if (now - parsed.ts < NONCE_TTL_SEC) return parsed.v;
      }
    } catch {}
  }
  const v = crypto.randomUUID().replace(/-/g, '');
  const rec = JSON.stringify({ v, ts: now });
  await setSecret(env, NONCE_AUTHZ_KEY, rec);
  return v;
}

export function setDpopNonceHeader(headers: Headers, nonce: string) {
  headers.set('DPoP-Nonce', nonce);
}

// Compute RFC7638 JWK thumbprint for P-256 JWK
async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  // Per RFC7638, canonical JSON with these members in lexicographic order
  const obj: Record<string, string> = {
    crv: String(jwk.crv ?? ''),
    kty: String(jwk.kty ?? ''),
    x: String(jwk.x ?? ''),
    y: String(jwk.y ?? ''),
  };
  const json = JSON.stringify(obj);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return b64url(digest);
}

function urlWithoutHash(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.toString();
  } catch {
    return u;
  }
}

// Convert raw r|s (64 bytes) JWS signature to DER sequence for WebCrypto
function jwsEs256ToDer(sig: Uint8Array): Uint8Array {
  // Helper to trim leading zeros and ensure positive integers
  function trim(bytes: Uint8Array): Uint8Array {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0] & 0x80) {
      const out = new Uint8Array(v.length + 1);
      out[0] = 0;
      out.set(v, 1);
      return out;
    }
    return v;
  }
  const r = trim(sig.slice(0, 32));
  const s = trim(sig.slice(32));
  const totalLen = 2 + r.length + 2 + s.length;
  const seqLen = totalLen;
  const der = new Uint8Array(2 + 1 + seqLen);
  let offset = 0;
  der[offset++] = 0x30; // SEQUENCE
  der[offset++] = 0x81; // length (assuming < 128+255)
  der[offset++] = seqLen;
  der[offset++] = 0x02; // INTEGER
  der[offset++] = r.length;
  der.set(r, offset);
  offset += r.length;
  der[offset++] = 0x02; // INTEGER
  der[offset++] = s.length;
  der.set(s, offset);
  return der;
}

export async function verifyDpop(env: Env, request: Request, opts?: { requireNonce?: boolean }): Promise<DpopVerification> {
  const dpop = request.headers.get('DPoP');
  const nonce = await getAuthzNonce(env);
  if (!dpop) {
    const err: any = new Error('DPoP required');
    (err as any).code = 'use_dpop_nonce';
    (err as any).nonce = nonce;
    throw err;
  }
  const [h, p, s] = dpop.split('.');
  if (!h || !p || !s) {
    const err: any = new Error('Invalid DPoP');
    (err as any).code = 'use_dpop_nonce';
    (err as any).nonce = nonce;
    throw err;
  }
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));

  if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk) {
    const err: any = new Error('Invalid DPoP header');
    (err as any).code = 'use_dpop_nonce';
    (err as any).nonce = nonce;
    throw err;
  }

  const method = request.method.toUpperCase();
  const url = urlWithoutHash(request.url);
  if (payload.htm !== method || payload.htu !== url) {
    const err: any = new Error('DPoP htm/htu mismatch');
    (err as any).code = 'use_dpop_nonce';
    (err as any).nonce = nonce;
    throw err;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== 'number' || now - payload.iat > 300) {
    const err: any = new Error('DPoP iat too old');
    (err as any).code = 'use_dpop_nonce';
    (err as any).nonce = nonce;
    throw err;
  }

  if (opts?.requireNonce !== false) {
    if (!payload.nonce || payload.nonce !== nonce) {
      const err: any = new Error('use_dpop_nonce');
      (err as any).code = 'use_dpop_nonce';
      (err as any).nonce = nonce;
      throw err;
    }
  }

  // Verify signature using JWK (ES256, JWS uses raw r|s signature)
  const key = (await crypto.subtle.importKey(
    'jwk',
    header.jwk as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )) as CryptoKey;

  const sigRaw = b64urlToBytes(s);
  if (sigRaw.length !== 64) {
    const err: any = new Error('Invalid DPoP signature');
    (err as any).code = 'use_dpop_nonce';
    (err as any).nonce = nonce;
    throw err;
  }
  const der = jwsEs256ToDer(sigRaw);
  const ok = await crypto.subtle.verify('ECDSA', key, der, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) {
    const err: any = new Error('Invalid DPoP signature');
    (err as any).code = 'use_dpop_nonce';
    (err as any).nonce = nonce;
    throw err;
  }

  const jkt = await jwkThumbprint(header.jwk as JsonWebKey);
  return { jkt, jwk: header.jwk as JsonWebKey, payload };
}

export function dpopErrorResponse(env: Env, error: any): Response {
  const nonce = (error && (error.nonce as string)) || '';
  const body = JSON.stringify({ error: 'use_dpop_nonce', error_description: 'Authorization server requires nonce in DPoP proof' });
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (nonce) headers.set('DPoP-Nonce', nonce);
  return new Response(body, { status: 401, headers });
}

export async function withDpop<T>(env: Env, request: Request, fn: (ver: DpopVerification) => Promise<T>): Promise<Response> {
  try {
    const ver = await verifyDpop(env, request);
    const result = await fn(ver);
    // Always include current nonce
    const nonce = await getAuthzNonce(env);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    setDpopNonceHeader(headers, nonce);
    if (result instanceof Response) {
      result.headers.set('DPoP-Nonce', nonce);
      return result;
    }
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (e: any) {
    if (e && e.code === 'use_dpop_nonce') {
      return dpopErrorResponse(env, e);
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    return new Response(JSON.stringify({ error: 'invalid_request', error_description: e?.message ?? 'Unknown error' }), { status: 400, headers });
  }
}

export async function sha256b64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return b64url(digest);
}

