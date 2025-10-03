import type { Env } from '../env';
import { getRuntimeString } from './secrets';

export interface JwtClaims {
  sub: string; // DID
  handle?: string;
  scope?: string;
  aud?: string;
  jti?: string;
  t: 'access' | 'refresh';
}

// JWT
export async function signJwt(env: Env, claims: JwtClaims, kind: 'access' | 'refresh'): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const ttlAccess = Number((env.PDS_ACCESS_TTL_SEC as string | undefined) ?? 3600);
  const ttlRefresh = Number((env.PDS_REFRESH_TTL_SEC as string | undefined) ?? 30 * 24 * 3600);
  const exp = iat + (kind === 'access' ? ttlAccess : ttlRefresh);

  // Build proper JWT claims
  const payload: Record<string, unknown> = {
    iss: env.PDS_HOSTNAME || 'alteran',
    sub: claims.sub,
    aud: claims.aud || env.PDS_HOSTNAME || 'alteran',
    iat,
    exp,
    t: kind,
  };

  // Add optional claims
  if (claims.handle) payload.handle = claims.handle;
  if (claims.scope) payload.scope = claims.scope;
  if (claims.jti) payload.jti = claims.jti;

  const secret = await getRuntimeString(
    env,
    kind === 'access' ? 'ACCESS_TOKEN_SECRET' : 'REFRESH_TOKEN_SECRET',
    kind === 'access' ? 'dev-access' : 'dev-refresh'
  );
  if (!secret) {
    throw new Error(`Missing ${kind === 'access' ? 'ACCESS_TOKEN_SECRET' : 'REFRESH_TOKEN_SECRET'}`);
  }
  const algorithm = (env.JWT_ALGORITHM as string | undefined) ?? 'HS256';

  if (algorithm === 'EdDSA') {
    return await eddsaJwtSign(payload, env);
  }

  return await hmacJwtSign(payload, secret);
}

export async function verifyJwt(env: Env, token: string): Promise<{ valid: boolean; payload: any } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));

  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

  let ok = false;
  if (header.alg === 'HS256' && header.typ === 'JWT') {
    const secret = await getRuntimeString(
      env,
      payload.t === 'refresh' ? 'REFRESH_TOKEN_SECRET' : 'ACCESS_TOKEN_SECRET',
      payload.t === 'refresh' ? 'dev-refresh' : 'dev-access'
    );
    if (!secret) return null;
    ok = await hmacJwtVerify(parts[0] + '.' + parts[1], parts[2], secret);
  } else if (header.alg === 'EdDSA' && header.typ === 'JWT') {
    ok = await eddsaJwtVerify(parts[0] + '.' + parts[1], parts[2], env);
  } else {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!ok || (payload.exp && now > payload.exp)) return null;
  return { valid: true, payload };
}

async function hmacJwtSign(payload: any, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const s = b64url(new Uint8Array(sig));
  return `${h}.${p}.${s}`;
}

async function hmacJwtVerify(data: string, sigB64: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sigB64), enc.encode(data));
  return !!ok;
}

async function eddsaJwtSign(payload: any, env: Env): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;

  // Import Ed25519 private key from env
  const keyData = await getRuntimeString(env, 'REPO_SIGNING_KEY');
  if (!keyData) {
    throw new Error('REPO_SIGNING_KEY not configured for EdDSA JWTs');
  }

  // Decode base64 private key
  const keyBytes = b64urlDecode(keyData);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('Ed25519', key, enc.encode(data));
  const s = b64url(new Uint8Array(sig));
  return `${h}.${p}.${s}`;
}

async function eddsaJwtVerify(data: string, sigB64: string, env: Env): Promise<boolean> {
  const enc = new TextEncoder();

  // Import Ed25519 public key from env
  const keyData = await getRuntimeString(env, 'REPO_SIGNING_PUBLIC_KEY');
  if (!keyData) {
    return false;
  }

  const keyBytes = b64urlDecode(keyData);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
    false,
    ['verify']
  );

  const ok = await crypto.subtle.verify('Ed25519', key, b64urlDecode(sigB64), enc.encode(data));
  return !!ok;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += String.fromCharCode(b[i]);
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
